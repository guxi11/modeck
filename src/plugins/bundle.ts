import { chmod, lstat, opendir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { canonical, checkRelativePath, LIMITS, modeError, parseJson, sha256 } from "../contracts/index.js";
import type { ConfigContext, PluginBundle, PluginDynamic, PluginSpec, TreeEntry } from "../contracts/index.js";
import { childPath, commitPattern, compare, ensureDirectory, exists, hashPattern, missing, regularBytes, requireValue, safePath, utf8 } from "../resources/fs.js";
import { extractTree, fetchCommit, gitSource, initGit } from "../resources/git.js";
import { treeDigest as digestTree, validateEntries, writeSnapshot } from "../resources/tree.js";
import type { Snapshot } from "../resources/tree.js";
import { withMcpMutex } from "../mcp/mutex.js";

type LockEntry = { id: string; source: PluginSpec["source"]; commit: string; treeDigest: string; entries: TreeEntry[];
  dynamic: PluginDynamic[]; name: string };
type Lock = { version: 1; plugins: LockEntry[] };
type BundleIntent = { version: 1; id: string; sourceUrl: string; sourcePath: string; commit: string; treeDigest: string; staging: string };
type VerifiedBundleFiles = { fingerprint: string; files: ReadonlyMap<string, Buffer> };
const verifiedBundleFiles = new WeakMap<PluginBundle, VerifiedBundleFiles>();
const lockPath = (root: string): string => join(root, "modeck-plugins-lock.json");
const bundlePath = (root: string, id: string, digest: string): string => join(root, "vendor", "plugins", id, digest);
const intentPath = (root: string, id: string): string => join(root, ".modeck", "plugin-bundles", `${id}.intent.json`);
const stageName = (id: string, digest: string): string => `.${id}-${digest.slice(0, 12)}-${randomUUID()}.stage`;
const validIntent = (value: unknown): value is BundleIntent => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (!(item.version === 1 && typeof item.id === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(item.id)
    && typeof item.sourceUrl === "string" && item.sourceUrl.length > 0 && item.sourceUrl.length <= LIMITS.urlLength
    && typeof item.sourcePath === "string" && typeof item.commit === "string" && commitPattern.test(item.commit)
    && typeof item.treeDigest === "string" && hashPattern.test(item.treeDigest)
    && typeof item.staging === "string" && new RegExp(`^\\.${item.id}-${item.treeDigest.slice(0, 12)}-[0-9a-f-]{36}\\.stage$`, "u").test(item.staging))) return false;
  try { checkRelativePath(item.sourcePath as string, true); } catch { return false; }
  return true;
};
const readIntent = async (root: string, id: string): Promise<BundleIntent | null> => {
  const path = intentPath(root, id);
  if (!await exists(path)) return null;
  const value = parseJson(utf8((await regularBytes(path, 16_384)).bytes));
  requireValue(validIntent(value) && value.id === id, "E_INSTALL_CONFLICT", "Plugin bundle owner intent is invalid", { id });
  return value as BundleIntent;
};
const sameSourceOwner = (intent: BundleIntent, source: PluginSpec["source"], path: string): boolean =>
  intent.sourceUrl === source.url && intent.sourcePath === path;
const sameIntent = (intent: BundleIntent, source: PluginSpec["source"], path: string, commit: string, digest: string): boolean =>
  sameSourceOwner(intent, source, path) && intent.commit === commit && intent.treeDigest === digest;
const writeIntent = async (root: string, intent: BundleIntent): Promise<void> => {
  const directory = await ensureDirectory(join(root, ".modeck", "plugin-bundles"));
  const temporary = join(directory, `.intent-${intent.id}-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(intent, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, intentPath(root, intent.id));
};
const hashTree = (entries: readonly TreeEntry[]): string => digestTree(entries);
const validLockEntry = (value: unknown): value is LockEntry => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(item.id)
    || typeof item.name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(item.name)
    || typeof item.commit !== "string" || !commitPattern.test(item.commit)
    || typeof item.treeDigest !== "string" || !hashPattern.test(item.treeDigest)
    || !Array.isArray(item.entries) || !Array.isArray(item.dynamic)
    || !item.source || typeof item.source !== "object" || Array.isArray(item.source)) return false;
  const source = item.source as Record<string, unknown>;
  if (typeof source.url !== "string" || !source.url || source.url.length > LIMITS.urlLength
    || typeof source.path !== "string" || typeof source.commit !== "string" || !commitPattern.test(source.commit)) return false;
  if (!item.entries.every(entry => entry && typeof entry === "object" && !Array.isArray(entry)
    && typeof (entry as Record<string, unknown>).path === "string"
    && ["file", "directory"].includes(String((entry as Record<string, unknown>).kind)))) return false;
  if (!item.dynamic.every(resource => resource && typeof resource === "object" && !Array.isArray(resource)
    && typeof (resource as Record<string, unknown>).id === "string"
    && typeof (resource as Record<string, unknown>).path === "string"
    && ["skill", "rule"].includes(String((resource as Record<string, unknown>).kind))
    && ((resource as Record<string, unknown>).agents === undefined
      || Array.isArray((resource as Record<string, unknown>).agents)
        && ((resource as Record<string, unknown>).agents as unknown[]).every(agent => agent === "claude" || agent === "codex")))) return false;
  return true;
};

const jsonObject = (text: string, path: string): Record<string, unknown> => {
  const value: unknown = parseJson(text);
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "E_INTEGRITY", "Plugin manifest must be a JSON object", { path });
  return value as Record<string, unknown>;
};
const readFiles = async (root: string, entries: readonly TreeEntry[]): Promise<Map<string, Buffer>> => {
  const files = entries.filter((entry): entry is Extract<TreeEntry, { kind: "file" }> => entry.kind === "file");
  const pairs = await Promise.all(files.map(async entry => {
    const path = childPath(root, entry.path);
    const file = await regularBytes(path, LIMITS.fileBytes);
    requireValue(file.bytes.length === entry.bytes && sha256(file.bytes) === entry.digest && file.executable === entry.executable,
      "E_INTEGRITY", "Plugin file differs from its locked tree", { path: entry.path });
    return [entry.path, file.bytes] as const;
  }));
  return new Map(pairs);
};
const verifyExactTree = async (root: string, entries: readonly TreeEntry[]): Promise<void> => {
  const safeRoot = await safePath(root);
  requireValue(safeRoot === root && (await lstat(root)).isDirectory(), "E_PATH", "Plugin bundle root is not a safe real directory", { root });
  const actual: string[] = [];
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    requireValue(depth <= LIMITS.scanDepth, "E_LIMIT", "Plugin bundle scan depth exceeded");
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const name = entry.name;
      const relative = prefix ? `${prefix}/${name}` : name;
      const path = childPath(root, relative);
      const stat = await lstat(path);
      requireValue(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()), "E_INTEGRITY", "Plugin bundle contains a link or special file", { path: relative });
      actual.push(relative);
      requireValue(actual.length <= LIMITS.treeEntries, "E_LIMIT", "Plugin bundle scan entry limit exceeded");
      if (stat.isDirectory()) await walk(path, relative, depth + 1);
    }
  };
  await walk(root, "", 0);
  const expected = entries.map(entry => entry.path);
  actual.sort(compare);
  requireValue(canonical(actual) === canonical(expected), "E_INTEGRITY", "Plugin bundle contains missing or unindexed files");
};
const verifyStageSubset = async (root: string, snapshot: Snapshot): Promise<{ prefixValid: true; contentComplete: boolean }> => {
  const expected = new Map(snapshot.entries.map(entry => [entry.path, entry]));
  const actual: string[] = [];
  let filesComplete = true;
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    requireValue(depth <= LIMITS.scanDepth, "E_LIMIT", "Plugin staging scan depth exceeded");
    const handle = await opendir(directory);
    for await (const child of handle) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      const entry = expected.get(relative);
      if (!entry) throw modeError("E_INSTALL_CONFLICT", "Plugin staging contains an unowned path", { path: relative });
      const path = childPath(root, relative);
      const stat = await lstat(path);
      requireValue(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()), "E_INSTALL_CONFLICT", "Plugin staging contains a link or special file", { path: relative });
      requireValue(stat.isDirectory() ? entry.kind === "directory" : entry.kind === "file",
        "E_INSTALL_CONFLICT", "Plugin staging path type differs from expected content", { path: relative });
      actual.push(relative);
      requireValue(actual.length <= LIMITS.treeEntries, "E_LIMIT", "Plugin staging entry limit exceeded");
      if (stat.isDirectory()) await walk(path, relative, depth + 1);
      else {
        const data = await regularBytes(path, LIMITS.fileBytes);
        const expectedFile = snapshot.files.get(relative);
        if (!expectedFile || data.executable !== expectedFile.executable || data.bytes.length > expectedFile.bytes.length
          || Buffer.compare(Buffer.from(expectedFile.bytes.subarray(0, data.bytes.length)), data.bytes) !== 0) {
          throw modeError("E_INSTALL_CONFLICT", "Plugin staging file is not an expected write prefix", { path: relative });
        }
        if (data.bytes.length !== expectedFile.bytes.length) filesComplete = false;
      }
    }
  };
  await walk(root, "", 0);
  const pathsComplete = canonical(actual.sort(compare)) === canonical(snapshot.entries.map(entry => entry.path));
  return { prefixValid: true, contentComplete: pathsComplete && filesComplete };
};
const removeVerifiedStage = async (root: string, snapshot: Snapshot): Promise<void> => {
  const expected = new Map(snapshot.entries.map(entry => [entry.path, entry]));
  const removeTree = async (directory: string, prefix: string): Promise<void> => {
    await chmod(directory, 0o700);
    const handle = await opendir(directory);
    for await (const child of handle) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      const entry = expected.get(relative);
      if (!entry) throw modeError("E_INSTALL_CONFLICT", "Plugin staging contains an unowned path", { path: relative });
      const path = childPath(root, relative);
      const stat = await lstat(path);
      requireValue(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile())
        && (stat.isDirectory() ? entry.kind === "directory" : entry.kind === "file"),
      "E_INSTALL_CONFLICT", "Plugin staging path type differs from expected content", { path: relative });
      if (stat.isDirectory()) {
        await removeTree(path, relative);
        await rmdir(path);
      } else {
        const data = await regularBytes(path, LIMITS.fileBytes);
        const file = snapshot.files.get(relative);
        requireValue(file && data.executable === file.executable && data.bytes.length <= file.bytes.length
          && Buffer.compare(Buffer.from(file.bytes.subarray(0, data.bytes.length)), data.bytes) === 0,
        "E_INSTALL_CONFLICT", "Plugin staging file is not an expected write prefix", { path: relative });
        await unlink(path);
      }
    }
  };
  await removeTree(root, "");
  await rmdir(root);
};
const cleanIntentStage = async (root: string, id: string, intent: BundleIntent, snapshot: Snapshot): Promise<void> => {
  const parent = await ensureDirectory(join(root, "vendor", "plugins", id));
  const stage = await safePath(join(parent, intent.staging), true);
  if (await exists(stage)) {
    await verifyStageSubset(stage, snapshot);
    await removeVerifiedStage(stage, snapshot);
  }
};
const intentSnapshot = async (repo: string, source: Awaited<ReturnType<typeof gitSource>>, intent: BundleIntent): Promise<Snapshot> => {
  const fetched = await fetchCommit(repo, source, intent.commit, source.protocol !== "file");
  requireValue(fetched === intent.commit, "E_INTEGRITY", "Plugin staging intent commit could not be verified", { id: intent.id });
  const snapshot = await extractTree(repo, fetched, intent.sourcePath, "skill", source.protocol);
  validateEntries(snapshot.entries);
  requireValue(hashTree(snapshot.entries) === intent.treeDigest, "E_INTEGRITY", "Plugin staging intent tree digest is invalid", { id: intent.id });
  return snapshot;
};
const materializeBundleTarget = async (root: string, id: string, source: PluginSpec["source"], path: string,
  repo: string, git: Awaited<ReturnType<typeof gitSource>>, commit: string, snapshot: Snapshot, oldEntry: LockEntry | undefined): Promise<void> => {
  const digest = hashTree(snapshot.entries);
  const target = bundlePath(root, id, digest);
  const parent = await ensureDirectory(dirname(target));
  const intent = await readIntent(root, id);
  requireValue(!intent || sameSourceOwner(intent, source, path), "E_INSTALL_CONFLICT",
    "Plugin bundle intent is owned by a different source URL or path", { id });
  const intentOwnsTarget = intent !== null && sameIntent(intent, source, path, commit, digest);
  const lockOwnsTarget = oldEntry?.treeDigest === digest;
  if (await exists(target)) {
    requireValue(intentOwnsTarget || lockOwnsTarget, "E_INSTALL_CONFLICT", "Refusing to claim an existing plugin bundle not recorded by a matching lock or owner intent", { id });
    await verifyExactTree(target, snapshot.entries);
    const existing = await readFiles(target, snapshot.entries);
    requireValue(existing.size === snapshot.files.size, "E_INSTALL_CONFLICT", "Existing plugin bundle does not match its content address", { id });
  }
  let activeIntent = intent;
  if (!activeIntent || !sameIntent(activeIntent, source, path, commit, digest)) {
    if (activeIntent) await cleanIntentStage(root, id, activeIntent, await intentSnapshot(repo, git, activeIntent));
    activeIntent = { version: 1, id, sourceUrl: source.url, sourcePath: path, commit, treeDigest: digest,
      staging: stageName(id, digest) };
    await writeIntent(root, activeIntent);
  }
  if (await exists(target)) return;
  const stage = await safePath(join(parent, activeIntent.staging), true);
  if (await exists(stage)) {
    const verification = await verifyStageSubset(stage, snapshot);
    if (verification.contentComplete) {
      await verifyExactTree(stage, snapshot.entries);
      const staged = await readFiles(stage, snapshot.entries);
      requireValue(staged.size === snapshot.files.size, "E_INTEGRITY", "Staged plugin bundle is incomplete", { id });
      requireValue(!await exists(target), "E_INSTALL_CONFLICT", "Plugin bundle target appeared during publication", { id });
      await rename(stage, target);
      return;
    } else {
      await removeVerifiedStage(stage, snapshot);
    }
  }
  await writeSnapshot(snapshot, stage, true);
  await verifyExactTree(stage, snapshot.entries);
  const staged = await readFiles(stage, snapshot.entries);
  requireValue(staged.size === snapshot.files.size, "E_INTEGRITY", "Staged plugin bundle is incomplete", { id });
  requireValue(!await exists(target), "E_INSTALL_CONFLICT", "Plugin bundle target appeared during publication", { id });
  await rename(stage, target);
};
const manifestAt = (files: ReadonlyMap<string, Buffer>, candidates: readonly string[]): { path: string; value: Record<string, unknown> } | null => {
  const found = candidates.flatMap(path => files.has(path) ? [{ path, value: jsonObject(utf8(files.get(path)!), path) }] : []);
  requireValue(found.length <= 1, "E_INTEGRITY", "Plugin contains competing manifests", { paths: found.map(value => value.path) });
  return found[0] ?? null;
};
const paths = (value: unknown, field: string): string[] => {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  requireValue(values.every(item => typeof item === "string"), "E_INTEGRITY", `Invalid plugin ${field} declaration`);
  return (values as string[]).map(path => { checkRelativePath(path.replace(/^\.\//u, "").replace(/\/$/u, "") || ".", true); return path.replace(/^\.\//u, "").replace(/\/$/u, ""); });
};
const descendants = (path: string, candidate: string): boolean => candidate === path || candidate.startsWith(`${path}/`);
const dynamicIndex = (files: ReadonlyMap<string, Buffer>, entries: readonly TreeEntry[]): { name: string; dynamic: PluginDynamic[] } => {
  const cc = manifestAt(files, [".claude-plugin/plugin.json"]);
  const portable = manifestAt(files, ["plugin.json"]);
  const legacy = manifestAt(files, [".codex-plugin/plugin.json"]);
  const codex = portable ?? legacy;
  const names = [cc?.value.name, codex?.value.name].filter(value => value !== undefined);
  requireValue(names.every(value => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value)), "E_INTEGRITY", "Invalid native plugin name");
  requireValue(new Set(names).size <= 1, "E_INTEGRITY", "Claude and Codex plugin manifests must use the same plugin name");
  requireValue(cc || codex, "E_INTEGRITY", "Plugin must include a Claude or Codex plugin manifest");
  const dynamicByPath = new Map<string, PluginDynamic>();
  const addSkills = (directory: string, agents: PluginDynamic["agents"], recursive = true): void => {
    requireValue(directory !== ".", "E_INTEGRITY", "Plugin skills cannot scan the entire package root");
    checkRelativePath(directory, false);
    const nativeRoots = ["commands", "agents", "hooks", "output-styles", "workflows", "themes", "monitors"];
    requireValue(!nativeRoots.some(root => descendants(root, directory) || descendants(directory, root)),
      "E_INTEGRITY", "A dynamic skills scan overlaps a native plugin component", { directory });
    const skillEntries = [...files.keys()].filter(path => descendants(directory, path) && path.endsWith("/SKILL.md")
      && (recursive || path.slice(directory.length + 1).split("/").length === 2));
    const direct = files.has(`${directory}/SKILL.md`) ? [directory] : [];
    [...new Set([...direct, ...skillEntries.map(path => path.slice(0, -"/SKILL.md".length))])].forEach(path => {
      const id = path.slice(path.lastIndexOf("/") + 1);
      const previous = dynamicByPath.get(path);
      const combined = previous?.agents === undefined || agents === undefined ? undefined
        : [...new Set([...previous.agents, ...agents])].sort(compare);
      dynamicByPath.set(path, { id, kind: "skill", path, ...(combined ? { agents: combined } : agents ? { agents } : {}) });
    });
  };
  // Claude always scans the conventional directory recursively.
  addSkills("skills", ["claude"]);
  for (const manifest of [cc, codex]) if (manifest) {
    const declared = paths(manifest.value.skills, "skills");
    if (manifest === cc) declared.filter(path => path !== "skills").forEach(path => {
      requireValue(entries.some(entry => entry.path === path || entry.path.startsWith(`${path}/`)),
        "E_INTEGRITY", "Claude plugin skills path does not exist", { manifest: manifest.path, path });
      addSkills(path, ["claude"]);
    });
    if (manifest === codex) {
      if (manifest === portable) {
        requireValue(declared.every(path => path === "skills"),
          "E_INTEGRITY", "Codex portable plugins only support the conventional root skills directory", { paths: declared, manifest: manifest.path });
        addSkills("skills", ["codex"], false);
      } else {
        const explicitSkills = declared.length > 0;
        const codexRoots = explicitSkills ? declared : ["skills"];
        for (const path of codexRoots) {
          const exists = entries.some(entry => entry.path === path || entry.path.startsWith(`${path}/`));
          requireValue(path !== "." && (!explicitSkills || exists),
            "E_INTEGRITY", "Codex legacy plugin skills path does not exist", { path, manifest: manifest.path });
          if (exists) addSkills(path, ["codex"]);
        }
        if (entries.some(entry => entry.path.startsWith(".codex-plugin/migrated-command-skills/"))) {
          addSkills(".codex-plugin/migrated-command-skills", ["codex"]);
        }
      }
    }
    const known = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "skills", "commands", "agents", "hooks", "mcpServers", "lspServers", "outputStyles", "workflows", "experimental", "extensions", "settings", "userConfig", "dependencies", "defaultEnabled", "metadata", "interface", "capabilities", "onboardingSkill", "apps", "channels", "types", "icon", "documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl"]);
    requireValue(Object.keys(manifest.value).every(key => known.has(key)), "E_INTEGRITY", "Plugin manifest has unknown component fields", { path: manifest.path });
  }
  const dynamic: PluginDynamic[] = [...dynamicByPath.values()];
  for (const path of [...files.keys()].filter(path => path.startsWith("rules/") && path.endsWith(".md"))) {
    dynamic.push({ id: path.slice("rules/".length, -3), kind: "rule", path });
  }
  requireValue(dynamic.every(item => item.id && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(item.id)), "E_INTEGRITY", "Invalid dynamic plugin resource path");
  requireValue(new Set(dynamic.map(item => `${item.kind}:${item.id}`)).size === dynamic.length, "E_INTEGRITY", "Duplicate dynamic plugin resource");
  return { name: String(names[0]), dynamic: dynamic.sort((a, b) => compare(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`)) };
};
const lockRead = async (root: string): Promise<Lock> => {
  try {
    const { bytes } = await regularBytes(lockPath(root), LIMITS.jsonBytes);
    const value = parseJson(utf8(bytes)) as Lock;
    requireValue(value?.version === 1 && Array.isArray(value.plugins) && value.plugins.length <= LIMITS.resources,
      "E_CONFIG", "Invalid plugin lock file");
    requireValue(value.plugins.every(validLockEntry)
      && new Set(value.plugins.map(item => item.id)).size === value.plugins.length,
    "E_CONFIG", "Invalid plugin lock entry");
    return value;
  } catch (error) { if (missing(error)) return { version: 1, plugins: [] }; throw error; }
};
const atomicLock = async (root: string, lock: Lock): Promise<void> => {
  const destination = lockPath(root);
  const temporary = join(root, `.modeck-plugins-lock-${process.pid}-${Date.now()}`);
  const bytes = `${JSON.stringify(lock, null, 2)}\n`;
  requireValue(Buffer.byteLength(bytes) <= LIMITS.jsonBytes, "E_LIMIT", "Plugin lock exceeds byte limit");
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
  await chmod(temporary, 0o644);
  await rename(temporary, destination);
};
const ensureIgnore = async (root: string): Promise<void> => {
  const path = join(root, ".gitignore");
  const current = await exists(path) ? utf8((await regularBytes(path, LIMITS.fileBytes)).bytes) : "";
  const lines = current.split(/\r?\n/u);
  const missingLines = ["/vendor/", "/.modeck/"].filter(line => !lines.includes(line));
  if (missingLines.length) await writeFile(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missingLines.join("\n")}\n`, { mode: 0o644 });
};
const makeBundle = (root: string, item: LockEntry, spec: PluginSpec): PluginBundle => ({
  id: item.id, name: item.name, root: bundlePath(root, item.id, item.treeDigest), commit: item.commit,
  treeDigest: item.treeDigest, entries: item.entries, dynamic: item.dynamic, spec,
});
const bundleFingerprint = (bundle: PluginBundle): string => sha256(Buffer.from(canonical({
  id: bundle.id, name: bundle.name, root: bundle.root, commit: bundle.commit, treeDigest: bundle.treeDigest,
  entries: bundle.entries, dynamic: bundle.dynamic, spec: bundle.spec,
})));
const cacheVerifiedBundleFiles = (bundle: PluginBundle, files: ReadonlyMap<string, Buffer>): PluginBundle => {
  verifiedBundleFiles.set(bundle, { fingerprint: bundleFingerprint(bundle),
    files: new Map([...files].map(([path, bytes]) => [path, Buffer.from(bytes)])) });
  return bundle;
};
const copyFiles = (files: ReadonlyMap<string, Buffer>): ReadonlyMap<string, Buffer> =>
  new Map([...files].map(([path, bytes]) => [path, Buffer.from(bytes)]));

export const initPluginBundles = async (context: ConfigContext): Promise<readonly PluginBundle[]> => {
  const root = await safePath(context.configRoot);
  return withMcpMutex([join(root, ".modeck", "plugin-bundles")], async () => {
    const current = await lockRead(root);
    const old = new Map(current.plugins.map(item => [item.id, item]));
    const snapshots = new Map<string, Snapshot>();
    const next = await Object.entries(context.config.plugins ?? {}).sort(([a], [b]) => compare(a, b)).reduce(async (pending, [id, spec]) => {
      const previous = await pending;
      requireValue(/^[a-z][a-z0-9-]{0,63}$/.test(id) && commitPattern.test(spec.source.commit), "E_CONFIG", "Plugin IDs and source commits must be valid and pinned", { id });
      const path = spec.source.path ?? ".";
      checkRelativePath(path, true);
      const oldEntry = old.get(id);
      requireValue(!oldEntry || oldEntry.source.url === spec.source.url
        && (oldEntry.source.path ?? ".") === path,
      "E_INSTALL_CONFLICT", "Plugin ID is already owned by a different source URL or path", { id });
      const source = await gitSource(spec.source.url, root);
      const repo = join(root, ".modeck", "plugin-repos", sha256(Buffer.from(spec.source.url)));
      await ensureDirectory(repo);
      try { await initGit(repo); } catch { /* Existing isolated cache. */ }
      const fetched = await fetchCommit(repo, source, spec.source.commit, source.protocol !== "file");
      requireValue(fetched === spec.source.commit, "E_INTEGRITY", "Fetched plugin commit does not match the configured pin", { id });
      const snapshot = await extractTree(repo, fetched, path, "skill", source.protocol);
      validateEntries(snapshot.entries);
      snapshots.set(id, snapshot);
      const digest = hashTree(snapshot.entries);
      const files = new Map([...snapshot.files].map(([filePath, file]) => [filePath, Buffer.from(file.bytes)]));
      const index = dynamicIndex(files, snapshot.entries);
      await materializeBundleTarget(root, id, spec.source, path, repo, source, fetched, snapshot, oldEntry);
      const nextEntry = { id, source: { ...spec.source, path }, commit: fetched, treeDigest: digest,
        entries: [...snapshot.entries], dynamic: index.dynamic, name: index.name } satisfies LockEntry;
      return [...previous, nextEntry];
    }, Promise.resolve([] as LockEntry[]));
    await ensureIgnore(root);
    const lock = { version: 1 as const, plugins: next };
    await atomicLock(root, lock);
    await Promise.all(next.map(async item => {
      const intent = await readIntent(root, item.id);
      if (!intent || !sameIntent(intent, item.source, item.source.path ?? ".", item.commit, item.treeDigest)) return;
      const snapshot = snapshots.get(item.id);
      if (!snapshot) throw modeError("E_INTEGRITY", "Plugin staging snapshot is unavailable", { id: item.id });
      await cleanIntentStage(root, item.id, intent, snapshot);
      await rm(intentPath(root, item.id), { force: true });
    }));
    return next.map(item => makeBundle(root, item, context.config.plugins![item.id]!));
  });
};

export const readPluginBundles = async (context: ConfigContext, ids?: readonly string[]): Promise<readonly PluginBundle[]> => {
  const root = await safePath(context.configRoot);
  const lock = await lockRead(root);
  const declarations = context.config.plugins ?? {};
  requireValue(lock.plugins.length === Object.keys(declarations).length
    && new Set(lock.plugins.map(item => item.id)).size === lock.plugins.length
    && lock.plugins.every(item => Object.hasOwn(declarations, item.id)),
  "E_RESOURCE_MISSING", "Plugin lock does not match configured plugins; run plugin init");
  const requested = ids === undefined ? Object.keys(declarations) : [...new Set(ids)];
  requireValue(requested.every(id => Object.hasOwn(declarations, id)), "E_CONFIG", "Unknown requested plugin", { ids: requested });
  const locked = new Map(lock.plugins.map(item => [item.id, item]));
  // Check every source pin and declaration, but inspect package trees only for selected plugins.
  Object.entries(declarations).forEach(([id, spec]) => {
    const item = locked.get(id);
    requireValue(item && item.source.url === spec.source.url && item.source.commit === spec.source.commit
      && (item.source.path ?? ".") === (spec.source.path ?? ".") && item.commit === spec.source.commit
      && hashPattern.test(item.treeDigest) && commitPattern.test(item.commit),
    "E_RESOURCE_MISSING", "Plugin lock is missing or stale; run plugin init", { id });
  });
  return Promise.all(Object.entries(declarations).filter(([id]) => requested.includes(id)).sort(([a], [b]) => compare(a, b)).map(async ([id, spec]) => {
    const item = locked.get(id)!;
    validateEntries(item!.entries);
    requireValue(hashTree(item!.entries) === item!.treeDigest, "E_INTEGRITY", "Plugin lock tree digest is invalid", { id });
    const target = bundlePath(root, id, item!.treeDigest);
    await verifyExactTree(target, item!.entries);
    const files = await readFiles(target, item!.entries);
    // Couple the exact-tree check to the bytes held for later consumption.
    await verifyExactTree(target, item!.entries);
    const index = dynamicIndex(files, item!.entries);
    requireValue(index.name === item!.name && canonical(index.dynamic) === canonical(item!.dynamic), "E_INTEGRITY", "Plugin dynamic resource index differs from the locked package", { id });
    return cacheVerifiedBundleFiles(makeBundle(root, item!, spec), files);
  }));
};

export const pluginFiles = async (bundle: PluginBundle): Promise<ReadonlyMap<string, Buffer>> => {
  const cached = verifiedBundleFiles.get(bundle);
  if (cached) {
    requireValue(cached.fingerprint === bundleFingerprint(bundle), "E_INTEGRITY", "Verified plugin bundle metadata changed after loading", { id: bundle.id });
    return copyFiles(cached.files);
  }
  validateEntries(bundle.entries);
  requireValue(hashTree(bundle.entries) === bundle.treeDigest, "E_INTEGRITY", "Plugin bundle tree digest is invalid", { id: bundle.id });
  await verifyExactTree(bundle.root, bundle.entries);
  const files = await readFiles(bundle.root, bundle.entries);
  await verifyExactTree(bundle.root, bundle.entries);
  return files;
};
