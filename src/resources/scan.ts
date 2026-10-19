import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { agentDefinitions, canonical, checkRelativePath, LIMITS, parseJson, sha256 } from "../contracts/index.js";
import type { Agent, Kind, TreeEntry } from "../contracts/index.js";
import { compare, exists, missing, regularBytes, requireValue, safePath, utf8 } from "./fs.js";
import { resourceEntry } from "./skill.js";
import { snapshotLocal } from "./tree.js";

export type ScannedResource = {
  readonly id: string; readonly kind: Kind; readonly name: string; readonly description: string;
  readonly treeDigest: string; readonly sources: readonly string[]; readonly aliases: readonly string[];
  readonly entries: readonly TreeEntry[];
  readonly origins: readonly { readonly path: string; readonly type: "global" | "evoloop" | "evoloop-orphan"; readonly sourcePath: string | null }[];
};
export type ScanResult = {
  readonly schemaVersion: 1; readonly home: string; readonly resources: readonly ScannedResource[];
  readonly conflicts: readonly { readonly name: string; readonly ids: readonly string[] }[];
  readonly excluded: readonly { readonly path: string; readonly reason: string }[];
  readonly manifests: readonly { readonly path: string; readonly digest: string; readonly root: string }[];
  readonly scanDigest: string;
};
type Candidate = Omit<ScannedResource, "id" | "sources" | "aliases" | "origins"> & { readonly source: string; readonly alias: string; readonly origin: ScannedResource["origins"][number] };
const targets = [".claude", ".codex", ".agents", ".codebuddy", ".codebuddy-cli", ".gemini", ".qwen", ".qoder"];
const markdownRuleTargets = new Set([".claude", ".codebuddy", ".qwen", ".qoder"]);
const ruleNames: Readonly<Record<string, string>> = { ".claude": "CLAUDE.md", ".codex": "AGENTS.md", ".codebuddy": "CODEBUDDY.md", ".codebuddy-cli": "CODEBUDDY.md", ".gemini": "GEMINI.md", ".qwen": "QWEN.md", ".qoder": "AGENTS.md" };
export type CatalogReferenceScan = {
  readonly references: readonly { readonly path: string; readonly source: string | null; readonly link: string;
    readonly ino: number; readonly dev: number; readonly mtime: number; readonly ctime: number }[];
  readonly referenceDigest: string;
};
// VCS metadata and dependency trees are never catalog entries; drop them before path validation instead of traversing.
const catalogEntries = async (directory: string): Promise<readonly string[]> =>
  (await readdir(directory)).filter(name => ![".git", "node_modules"].includes(name.toLowerCase())).sort(compare);
// Resolve a catalog link, yielding null for dangling or looping links.
const target = (path: string): Promise<string | null> => realpath(path).catch(error => {
  if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(error.code))) return null;
  throw error;
});

// Enumerate references without reading resource contents; canonical directory visits bound aliases and cycles.
export const scanCatalogReferences = async (home: string): Promise<CatalogReferenceScan> => {
  const root = await safePath(home);
  const references: CatalogReferenceScan["references"][number][] = [];
  let visited = 0;
  const traversed = new Set<string>();
  const platformRoots = targets.flatMap(target => ["plugins", "packages"].map(name => join(root, target, name)));
  const walk = async (path: string, depth: number, children?: readonly string[]): Promise<void> => {
    requireValue(depth <= LIMITS.scanDepth && ++visited <= LIMITS.scanEntries,
      "E_SCAN_LIMIT", "Catalog reference scan limit exceeded");
    const info = await lstat(path).catch(error => { if (missing(error)) return null; throw error; });
    if (!info) return;
    if (info.isSymbolicLink()) {
      const link = await readlink(path);
      requireValue(link.length <= LIMITS.pathLength, "E_SCAN_LIMIT", "Catalog reference path is too long", { path });
      const source = await target(path);
      const after = await lstat(path);
      requireValue(after.ino === info.ino && after.dev === info.dev && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs,
        "E_PLAN_STALE", "Catalog reference changed while scanning", { path });
      references.push({ path, source, link, ino: info.ino, dev: info.dev, mtime: info.mtimeMs, ctime: info.ctimeMs });
      if (source !== null && !platformRoots.some(root => source === root || source.startsWith(`${root}/`))) {
        requireValue(source.length <= LIMITS.pathLength, "E_SCAN_LIMIT", "Resolved catalog reference path is too long", { path });
        await walk(source, depth + 1, children);
      }
      return;
    }
    if (!info.isDirectory()) return;
    await safePath(path);
    const key = `${path}\0${children?.join(",") ?? "*"}`;
    if (traversed.has(key) || traversed.has(`${path}\0*`)) return;
    traversed.add(key);
    const names = children ?? await catalogEntries(path);
    requireValue(visited + names.length <= LIMITS.scanEntries, "E_SCAN_LIMIT", "Catalog reference scan limit exceeded");
    await names.reduce(async (pending, name) => {
      await pending; checkRelativePath(name, false);
      const child = join(path, name);
      requireValue(child.length <= LIMITS.pathLength, "E_SCAN_LIMIT", "Catalog reference path is too long", { path: child });
      await walk(child, depth + 1);
    }, Promise.resolve());
  };
  await targets.reduce(async (pending, target) => {
    await pending;
    await walk(join(root, target), 0, ["skills", "rules", ...(ruleNames[target] ? [ruleNames[target]!] : [])]);
  }, Promise.resolve());
  const sorted = references.sort((a, b) => compare(a.path, b.path));
  return { references: sorted, referenceDigest: sha256(Buffer.from(canonical(sorted))) };
};

const object = (value: unknown): Record<string, unknown> => {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "E_CONFIG", "Expected an object");
  return value as Record<string, unknown>;
};
const resourceId = (name: string): string => {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return (/^[a-z]/.test(slug) ? slug : `resource-${slug}`).slice(0, 48).replace(/-+$/g, "");
};

const scanCatalog = async (home: string, project: boolean, agents?: readonly Agent[]): Promise<ScanResult> => {
  const catalogs = project ? [".claude", ".agents", ".codebuddy", ".qwen", ".qoder"]
    : agents ? [...new Set(agents.flatMap(agent => agentDefinitions[agent].scanDirectories))] : targets;
  const root = await safePath(home);
  requireValue((await lstat(root)).isDirectory(), "E_PATH", "HOME must be a directory");
  const candidates: Candidate[] = [];
  const excluded: { path: string; reason: string }[] = [];
  const manifests: { path: string; digest: string; root: string }[] = [];
  const managedRules = new Map<string, string>();
  const scannedRuleRoots = new Set<string>();
  const managedSkills = new Map<string, string>();
  const platformRoots = targets.flatMap(target => ["plugins", "packages"].map(name => join(root, target, name)));
  const platformSource = (source: string): boolean => platformRoots.some(path => source === path || source.startsWith(`${path}/`));
  let visited = 0;
  let totalBytes = 0;
  const add = async (alias: string, kind: Kind): Promise<void> => {
    // Only catalog entry aliases may resolve links. snapshotLocal rejects every
    // link inside a resource, including links to other files in the same tree.
    const source = await realpath(alias);
    if (platformSource(source)) { excluded.push({ path: alias, reason: "Alias to platform installation/cache; excluded without traversal" }); return; }
    const snapshot = await snapshotLocal(source, kind);
    const entry = resourceEntry(snapshot, kind);
    const expectedSource = managedSkills.get(alias) ?? null;
    const origin = { path: alias, type: expectedSource === null ? "global" as const
      : await exists(join(expectedSource, "SKILL.md")) ? "evoloop" as const : "evoloop-orphan" as const, sourcePath: expectedSource };
    totalBytes += snapshot.entries.reduce((sum, item) => sum + (item.kind === "file" ? item.bytes : 0), 0);
    requireValue(totalBytes <= LIMITS.allResourceBytes, "E_LIMIT", "Scan resource bytes exceeded");
    candidates.push({ kind, source, alias, origin, name: entry.skill?.name ?? resourceId(basename(source).replace(/\.[^.]+$/, "")),
      description: entry.skill?.description ?? "Global instructions", treeDigest: snapshot.treeDigest, entries: snapshot.entries });
  };
  const walk = async (alias: string, kind: Kind, ancestors: readonly string[] = []): Promise<void> => {
    if (!await exists(alias)) return;
    const source = await target(alias);
    if (source === null) { excluded.push({ path: alias, reason: "Dangling or looping catalog link; excluded without traversal" }); return; }
    if (kind === "skill" && [alias, source].some(path => path === join(root, ".codex/skills/.system")
      || path.startsWith(`${join(root, ".codex/skills/.system")}/`))) {
      excluded.push({ path: alias, reason: "Codex built-in skills; retained without traversal" }); return;
    }
    if (platformSource(source)) { excluded.push({ path: alias, reason: "Alias to platform installation/cache; excluded without traversal" }); return; }
    await safePath(source);
    requireValue(!ancestors.includes(source), "E_PATH", "Catalog symlink cycle", { path: alias });
    requireValue(ancestors.length <= LIMITS.scanDepth && ++visited <= LIMITS.scanEntries, "E_SCAN_LIMIT", "Catalog scan limit exceeded");
    const info = await lstat(source);
    requireValue(info.isFile() || info.isDirectory(), "E_PATH", "Special catalog file rejected", { path: alias });
    if (kind === "rule" && info.isFile()) {
      if (basename(alias).endsWith(".md")) await add(alias, kind);
      return;
    }
    requireValue(info.isDirectory(), "E_PATH", "Skill catalog entry must be a directory", { path: alias });
    if (kind === "skill" && (!project || ancestors.length > 0) && await exists(join(source, "SKILL.md"))) {
      await add(alias, kind);
      if (!alias.startsWith(`${join(root, ".codebuddy", "skills")}/`)) return;
    }
    // Claude loads direct skill directories, not nested catalog groups.
    if (project && ancestors.length > 0 && alias.startsWith(`${join(root, ".claude", "skills")}/`)) return;
    const names = await catalogEntries(source);
    requireValue(visited + names.length <= LIMITS.scanEntries, "E_SCAN_LIMIT", "Catalog scan limit exceeded");
    visited += names.length;
    await names.reduce(async (pending, name) => {
      await pending;
      checkRelativePath(name, false);
      const child = join(alias, name);
      const stat = await lstat(child);
      if (kind === "skill" && stat.isFile()) return;
      await walk(child, kind, [...ancestors, source]);
    }, Promise.resolve());
  };
  await (project ? [] : catalogs).reduce(async (pending, target) => {
    await pending;
    const directory = join(root, target);
    const manifestPath = join(directory, ".evoloop-manifest.json");
    if (!await exists(manifestPath)) return;
    const { bytes } = await regularBytes(manifestPath, LIMITS.manifestBytes);
    const manifest = object(parseJson(utf8(bytes)));
    requireValue(typeof manifest.root === "string", "E_CONFIG", "Invalid evoloop source root", { path: manifestPath });
    const source = await safePath(manifest.root as string);
    manifests.push({ path: manifestPath, digest: sha256(bytes), root: source });
    const rule = ruleNames[target];
    if (rule && Array.isArray(manifest.files) && manifest.files.includes(rule)) managedRules.set(join(directory, rule), source);
    if (Array.isArray(manifest.files)) manifest.files.forEach(path => {
      if (typeof path !== "string" || !path.startsWith("skills/") || !path.endsWith("/SKILL.md")) return;
      checkRelativePath(path, false);
      const skill = dirname(path);
      managedSkills.set(join(directory, skill), join(source, skill));
    });
    // A manifest records ownership, not the presence of native resources.
    // Scan skills only through entries that still exist in the selected catalogs.
  }, Promise.resolve());
  await catalogs.reduce(async (pending, target) => {
    await pending;
    const directory = join(root, target);
    if (!await exists(directory)) return;
    await safePath(directory);
    const rule = ruleNames[target];
    if (!project && rule && await exists(join(directory, rule))) {
      const path = join(directory, rule);
      const generated = managedRules.has(path)
        && utf8((await regularBytes(await realpath(path), LIMITS.textFileBytes)).bytes).startsWith("<!-- GENERATED by evoloop");
      if (generated) {
        excluded.push({ path, reason: "evoloop generated aggregate; source rules scanned instead" });
        const source = managedRules.get(path)!;
        if (!scannedRuleRoots.has(source)) {
          scannedRuleRoots.add(source);
          await walk(join(source, "rules"), "rule");
        }
      }
      else await add(path, "rule");
    }
    if (!project && markdownRuleTargets.has(target)) await walk(join(directory, "rules"), "rule");
    await walk(join(directory, "skills"), "skill");
    if (target === ".codex" && await exists(join(directory, "rules"))) excluded.push({
      path: join(directory, "rules"), reason: "Codex execution policies (*.rules), not natural-language instructions; excluded without traversal" });
    // Platform installation trees are intentionally outside the allowlist.
    await ["plugins", "packages"].reduce(async (done, name) => {
      await done;
      const path = join(directory, name);
      if (await exists(path)) excluded.push({ path, reason: "Platform installation/cache; excluded without traversal" });
    }, Promise.resolve());
  }, Promise.resolve());
  const groups = [...candidates.reduce((map, item) => {
    const key = `${item.kind}:${item.treeDigest}`;
    map.set(key, [...(map.get(key) ?? []), item]);
    return map;
  }, new Map<string, Candidate[]>()).values()];
  const resources = groups.map(group => {
    const item = group[0]!;
    const base = resourceId(item.name);
    const collision = groups.some(other => other !== group && resourceId(other[0]!.name) === base);
    return { id: collision ? `${base}-${item.treeDigest.slice(0, 12)}` : base,
      kind: item.kind, name: item.name, description: item.description, treeDigest: item.treeDigest, entries: item.entries,
      sources: [...new Set(group.map(candidate => candidate.source))].sort(compare),
      origins: group.map(candidate => candidate.origin).filter((item, index, items) => items.findIndex(other => other.path === item.path) === index)
        .sort((a, b) => compare(a.path, b.path)),
      aliases: [...new Set(group.map(candidate => candidate.alias))].sort(compare) };
  }).sort((a, b) => compare(a.id, b.id));
  requireValue(new Set(resources.map(item => item.id)).size === resources.length, "E_INTEGRITY", "Resource id hash collision");
  const conflicts = [...new Set(resources.map(item => item.name))].flatMap(name => {
    const matching = resources.filter(item => item.name === name);
    return matching.length > 1 ? [{ name, ids: matching.map(item => item.id) }] : [];
  });
  const result = { schemaVersion: 1 as const, home: root, resources, conflicts,
    excluded: excluded.sort((a, b) => compare(a.path, b.path)), manifests: manifests.sort((a, b) => compare(a.path, b.path)) };
  return { ...result, scanDigest: sha256(Buffer.from(canonical(result))) };
};

export const scanHome = (home: string, agents?: readonly Agent[]): Promise<ScanResult> => scanCatalog(home, false, agents);
export const scanProject = (cwd: string): Promise<ScanResult> => scanCatalog(cwd, true);
