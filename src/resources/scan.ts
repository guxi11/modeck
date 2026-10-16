import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonical, checkRelativePath, LIMITS, parseJson, sha256 } from "../contracts/index.js";
import type { Kind, TreeEntry } from "../contracts/index.js";
import { compare, exists, regularBytes, requireValue, safePath, utf8 } from "./fs.js";
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
const targets = [".claude", ".codex", ".agents", ".codebuddy", ".codebuddy-cli", ".gemini"];
const markdownRuleTargets = new Set([".claude", ".codebuddy"]);
const ruleNames: Readonly<Record<string, string>> = { ".claude": "CLAUDE.md", ".codex": "AGENTS.md", ".codebuddy": "CODEBUDDY.md", ".codebuddy-cli": "CODEBUDDY.md", ".gemini": "GEMINI.md" };
const object = (value: unknown): Record<string, unknown> => {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "E_CONFIG", "Expected an object");
  return value as Record<string, unknown>;
};
const resourceId = (name: string): string => {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return (/^[a-z]/.test(slug) ? slug : `resource-${slug}`).slice(0, 48).replace(/-+$/g, "");
};

export const scanHome = async (home: string): Promise<ScanResult> => {
  const root = await safePath(home);
  requireValue((await lstat(root)).isDirectory(), "E_PATH", "HOME must be a directory");
  const candidates: Candidate[] = [];
  const excluded: { path: string; reason: string }[] = [];
  const manifests: { path: string; digest: string; root: string }[] = [];
  const managedRules = new Set<string>();
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
    const source = await realpath(alias);
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
    if (kind === "skill" && await exists(join(source, "SKILL.md"))) { await add(alias, kind); return; }
    const names = (await readdir(source)).sort(compare);
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
  await targets.reduce(async (pending, target) => {
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
    if (rule && Array.isArray(manifest.files) && manifest.files.includes(rule)) managedRules.add(join(directory, rule));
    if (Array.isArray(manifest.files)) manifest.files.forEach(path => {
      if (typeof path !== "string" || !path.startsWith("skills/") || !path.endsWith("/SKILL.md")) return;
      checkRelativePath(path, false);
      const skill = dirname(path);
      managedSkills.set(join(directory, skill), join(source, skill));
    });
    if (!manifests.slice(0, -1).some(item => item.root === source)) {
      await walk(join(source, "rules"), "rule");
      await walk(join(source, "skills"), "skill");
    }
  }, Promise.resolve());
  await targets.reduce(async (pending, target) => {
    await pending;
    const directory = join(root, target);
    if (!await exists(directory)) return;
    await safePath(directory);
    const rule = ruleNames[target];
    if (rule && await exists(join(directory, rule))) {
      const path = join(directory, rule);
      const generated = managedRules.has(path)
        && utf8((await regularBytes(await realpath(path), LIMITS.textFileBytes)).bytes).startsWith("<!-- GENERATED by evoloop");
      if (generated) excluded.push({ path, reason: "evoloop generated aggregate; source rules scanned instead" });
      else await add(path, "rule");
    }
    if (markdownRuleTargets.has(target)) await walk(join(directory, "rules"), "rule");
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
