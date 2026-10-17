import { chmod, cp, mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LIMITS, parseJson, useResourcePath } from "../contracts/index.js";
import type { Kind } from "../contracts/index.js";
import { loadConfig, validateConfig } from "../core/config.js";
import { childPath, commitPattern, exists, hashPattern, regularBytes, requireValue, safePath, utf8 } from "../resources/fs.js";
import { extractTree, fetchCommit, git, gitSource, initGit } from "../resources/git.js";
import { snapshotLocal, writeSnapshot } from "../resources/tree.js";

type Declaration = Readonly<{ id: string; kind: Kind; url: string; path: string; target: string; ref: string }>;
type Entry = Omit<Declaration, "id" | "kind"> & Readonly<{ id?: string; kind?: Kind; commit: string; digest: string; date?: string; tag?: string | null }>;
type Lock = Readonly<{ version: 1; resources: readonly Entry[] }>;
type Status = "installed" | "restored" | "skipped" | "updated" | "unchanged";
type Prepared = Readonly<{ entry: Entry; target: string; staged: string | null; status: Status; before: string | null }>;
const resourceFile = "modeck-lock.json";
const legacyFile = "modeck-resources.json";
const overlaps = (left: string, right: string): boolean => {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};
const validate = (root: string, entry: Entry): void => {
  requireValue(entry && [entry.url, entry.path, entry.target, entry.ref, entry.commit, entry.digest].every(value => typeof value === "string" && value.length > 0), "E_CONFIG", "Invalid external resource entry");
  requireValue((entry.date === undefined || typeof entry.date === "string" && Number.isFinite(Date.parse(entry.date)))
    && (entry.tag === undefined || entry.tag === null || typeof entry.tag === "string" && entry.tag.length > 0), "E_CONFIG", "Invalid external resource metadata");
  requireValue((entry.kind === undefined || entry.kind === "rule" || entry.kind === "skill")
    && (entry.id === undefined || typeof entry.id === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(entry.id)), "E_CONFIG", "Invalid external resource identity");
  childPath(root, entry.path, entry.kind !== "rule");
  childPath(root, entry.target);
  const parts = entry.target.toLowerCase().split("/");
  requireValue(parts.every((part, index) => !part.startsWith(".") || index === 0 && part === ".modeck" && parts[1] === "resources" && parts.length > 2)
    && !/[\s*?![\]\\#]/.test(entry.target)
    && ![resourceFile, legacyFile, "modeck.yaml", "modeck.yml", "modeck-auto.mjs", "update-skills.mjs", "agents.md", "package.json", "package-lock.json"].includes(entry.target.toLowerCase()), "E_PATH", "Unsafe external resource target");
  requireValue(commitPattern.test(entry.commit) && hashPattern.test(entry.digest), "E_CONFIG", "Invalid external resource lock digest");
};
const readLock = async (root: string): Promise<{ lock: Lock; legacy: boolean }> => {
  const legacy = !await exists(join(root, resourceFile)) && await exists(join(root, legacyFile));
  const file = join(root, legacy ? legacyFile : resourceFile);
  if (!await exists(file)) return { lock: { version: 1, resources: [] }, legacy: false };
  const lock = parseJson(utf8((await regularBytes(file, LIMITS.jsonBytes)).bytes)) as Lock;
  requireValue(lock?.version === 1 && Array.isArray(lock.resources), "E_CONFIG", "Invalid external resource lock");
  lock.resources.forEach(entry => validate(root, entry));
  requireValue(lock.resources.every((entry, index, entries) => entries.every((other, otherIndex) => index === otherIndex
    || !overlaps(entry.target, other.target))), "E_CONFIG", "External resource targets overlap");
  return { lock, legacy };
};
const sameSource = (left: Declaration, right: Entry): boolean =>
  left.url === right.url && left.path === right.path && left.target === right.target && left.ref === right.ref
    && left.kind === (right.kind ?? "skill");
const currentDigest = async (target: string, kind: Kind): Promise<string | null> =>
  await exists(target) ? (await snapshotLocal(target, kind)).treeDigest : null;

export const manageResources = async (root: string, action: string): Promise<Lock & {
  results: readonly { target: string; status: Status; commit: string; digest: string }[];
  summary: Readonly<Record<Status | "total", number>>;
}> => {
  requireValue(action !== "add", "E_USAGE", "Declare resources.rules or resources.skills as (use URL)/path in modeck.yaml, then run modeck res init");
  requireValue(["init", "update"].includes(action), "E_USAGE", "Expected res init or res update");
  await safePath(root);
  const state = join(root, ".modeck");
  await safePath(state, true);
  await mkdir(state, { recursive: true });
  await safePath(state);
  const mutex = join(state, "resources.lock");
  try { await mkdir(mutex); } catch { requireValue(false, "E_BUSY", "External resources are already being modified"); }
  try {
    const context = await loadConfig({ configRoot: root });
    const declarations: readonly Declaration[] = Object.entries(context.config.resources).flatMap(([id, spec]) =>
      spec.source.type === "use" ? [{ id, kind: spec.kind, url: spec.source.url, path: spec.source.path,
        target: useResourcePath(id, spec.kind), ref: "HEAD" }] : []);
    const { lock, legacy } = await readLock(root);
    const migrating = legacy || lock.resources.some(entry => entry.kind === undefined);
    requireValue(!migrating || lock.resources.every(entry => declarations.some(declaration => sameSource(declaration, entry))),
      "E_CONFIG", "Migrate every legacy lock resource to a matching (use URL)/path mapping and its automatic cache path before installing");
    declarations.forEach((entry, index) => {
      validate(root, { ...entry, commit: "0".repeat(40), digest: "0".repeat(64) });
      requireValue(declarations.every((other, otherIndex) => index === otherIndex || !overlaps(entry.target, other.target)), "E_CONFIG", "External resource targets overlap");
      requireValue(lock.resources.every(other => other.target.toLowerCase() === entry.target.toLowerCase() || !overlaps(entry.target, other.target)), "E_INSTALL_CONFLICT", "External resource target overlaps a locked target");
    });
    const lockPath = join(root, resourceFile);
    await safePath(lockPath, true);
    const ignoreFile = join(root, ".gitignore");
    await safePath(ignoreFile, true);
    const ignorePresent = await exists(ignoreFile);
    const ignore = ignorePresent ? utf8((await regularBytes(ignoreFile, LIMITS.jsonBytes)).bytes) : "";
    const staging = await mkdtemp(join(mutex, "stage-"));
    const progress = (index: number, phase: string): void => {
      process.stderr.write(`modeck res ${action}: [${index + 1}/${declarations.length}] ${phase}\n`);
    };
    try {
      const prepared = await declarations.reduce(async (pending, declaration, index) => {
        const previous = await pending;
        progress(index, "checking");
        const locked = lock.resources.find(entry => entry.target.toLowerCase() === declaration.target.toLowerCase());
        const matching = locked !== undefined && sameSource(declaration, locked);
        const target = childPath(root, declaration.target);
        await safePath(target, true);
        const before = await currentDigest(target, declaration.kind);
        if (before !== null) {
          requireValue(locked, "E_INSTALL_CONFLICT", "External resource target is not managed", { target: declaration.target });
          requireValue(before === locked!.digest, "E_INSTALL_CONFLICT", "External resource has local modifications", { target: declaration.target });
        }
        if (action === "init" && matching && before !== null) {
          progress(index, "skipped");
          return [...previous, { entry: { ...locked!, ...declaration }, target, staged: null, status: "skipped" as const, before }];
        }
        progress(index, "downloading");
        const repo = join(staging, `repo-${index}`);
        await mkdir(repo);
        await initGit(repo);
        const source = await gitSource(declaration.url, root);
        const restoring = action === "init" && matching;
        const commit = await fetchCommit(repo, source, restoring ? locked!.commit : declaration.ref, source.protocol !== "file");
        const snapshot = await extractTree(repo, commit, declaration.path, declaration.kind, source.protocol);
        requireValue(!restoring || snapshot.treeDigest === locked!.digest, "E_INTEGRITY", "External resource digest differs from lock");
        const date = restoring && locked!.date !== undefined ? locked!.date
          : utf8(await git(repo, ["show", "-s", "--format=%cI", commit])).trim();
        const tags = restoring ? "" : utf8(await git(repo, ["ls-remote", "--tags", "--", source.url], source.protocol));
        const tag = restoring ? locked!.tag ?? null : tags.split("\n").flatMap(line => {
          const match = /^([0-9a-f]{40})\trefs\/tags\/(.+?)(?:\^\{\})?$/.exec(line);
          return match?.[1] === commit ? [match[2]!] : [];
        }).sort()[0] ?? null;
        const entry: Entry = { ...declaration, commit, digest: snapshot.treeDigest, date, tag };
        const status: Status = restoring ? "restored" : before === null ? "installed" : before === snapshot.treeDigest ? "unchanged" : "updated";
        const staged = before === snapshot.treeDigest ? null : join(staging, `tree-${index}`);
        if (staged) {
          if (declaration.kind === "rule") {
            const file = snapshot.files.get("content.md")!;
            const mode = file.executable ? 0o755 : 0o644;
            await writeFile(staged, file.bytes, { flag: "wx", mode });
            await chmod(staged, mode);
          } else await writeSnapshot(snapshot, staged, false);
        }
        progress(index, "prepared");
        return [...previous, { entry, target, staged, status, before }];
      }, Promise.resolve<readonly Prepared[]>([]));
      await validateConfig(context);
      const pattern = "/.modeck/";
      const ignoreNeeded = !ignore.split(/\r?\n/).includes(pattern);
      const result: Lock = { version: 1, resources: prepared.map(item => item.entry) };
      const bytes = `${JSON.stringify(result, null, 2)}\n`;
      requireValue(Buffer.byteLength(bytes) <= LIMITS.jsonBytes, "E_LIMIT", "External resource lock exceeds byte limit");
      await writeFile(join(mutex, "lock"), bytes);
      const replacements: { target: string; sibling: string; hadPrevious: boolean; installed: boolean }[] = [];
      let ignoreWritten = false;
      try {
        for (const [index, item] of prepared.entries()) {
          await safePath(item.target, true);
          requireValue(await currentDigest(item.target, item.entry.kind ?? "skill") === item.before, "E_INSTALL_CONFLICT", "External resource changed during installation", { target: item.entry.target });
          if (!item.staged) { progress(index, item.status); continue; }
          await mkdir(dirname(item.target), { recursive: true });
          const sibling = await mkdtemp(join(dirname(item.target), ".modeck-resource-"));
          const replacement = { target: item.target, sibling, hadPrevious: false, installed: false };
          replacements.push(replacement);
          // Keep all previous trees until the new lock is committed, allowing rollback across targets.
          await cp(item.staged, join(sibling, "new"), { recursive: true });
          if (item.before !== null) { await rename(item.target, join(sibling, "old")); replacement.hadPrevious = true; }
          await rename(join(sibling, "new"), item.target);
          replacement.installed = true;
          progress(index, item.status);
        }
        await validateConfig(context);
        if (ignoreNeeded) {
          await safePath(ignoreFile, true);
          ignoreWritten = true;
          await writeFile(ignoreFile, `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}${pattern}\n`);
        }
        await safePath(lockPath, true);
        await rename(join(mutex, "lock"), lockPath);
      } catch (error) {
        for (const replacement of [...replacements].reverse()) {
          if (replacement.installed) await rm(replacement.target, { recursive: true, force: true });
          if (replacement.hadPrevious) await rename(join(replacement.sibling, "old"), replacement.target);
        }
        if (ignoreWritten) {
          if (ignorePresent) await writeFile(ignoreFile, ignore);
          else await unlink(ignoreFile);
        }
        throw error;
      } finally {
        for (const replacement of replacements) await rm(replacement.sibling, { recursive: true, force: true });
      }
      if (legacy) await unlink(join(root, legacyFile));
      const results = prepared.map(({ entry, status }) => ({ target: entry.target, status, commit: entry.commit, digest: entry.digest }));
      const summary = results.reduce((counts, item) => ({ ...counts, [item.status]: counts[item.status] + 1 }),
        { total: results.length, installed: 0, restored: 0, skipped: 0, updated: 0, unchanged: 0 });
      process.stderr.write(`modeck res ${action}: complete (${summary.total} resources)\n`);
      return { ...result, results, summary };
    } finally { await rm(staging, { recursive: true, force: true }); }
  } finally { await rm(mutex, { recursive: true, force: true }); }
};
