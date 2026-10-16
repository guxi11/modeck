import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LIMITS, parseJson } from "../contracts/index.js";
import { childPath, commitPattern, exists, hashPattern, regularBytes, requireValue, safePath, utf8 } from "../resources/fs.js";
import { extractTree, fetchCommit, git, gitSource, initGit } from "../resources/git.js";
import { snapshotLocal, writeSnapshot } from "../resources/tree.js";

type Entry = Readonly<{ url: string; path: string; target: string; ref: string; commit: string; digest: string; date: string; tag: string | null }>;
type Lock = Readonly<{ version: 1; resources: readonly Entry[] }>;
const resourceFile = "modup-resources.json";
const validate = (root: string, entry: Entry): void => {
  requireValue(entry && [entry.url, entry.path, entry.target, entry.ref, entry.commit, entry.digest].every(value => typeof value === "string" && value.length > 0), "E_CONFIG", "Invalid external resource entry");
  requireValue((entry.date === undefined || typeof entry.date === "string" && Number.isFinite(Date.parse(entry.date)))
    && (entry.tag === undefined || entry.tag === null || typeof entry.tag === "string" && entry.tag.length > 0), "E_CONFIG", "Invalid external resource metadata");
  childPath(root, entry.path, true);
  childPath(root, entry.target);
  requireValue(!entry.target.split("/").some(part => part.startsWith(".")) && !/[\s*?![\]\\#]/.test(entry.target)
    && ![resourceFile, "update-skills.mjs", "AGENTS.md", "package.json", "package-lock.json"].includes(entry.target), "E_PATH", "Unsafe external resource target");
  requireValue(commitPattern.test(entry.commit) && hashPattern.test(entry.digest), "E_CONFIG", "Invalid external resource lock digest");
};
const readLock = async (root: string): Promise<Lock> => {
  const file = join(root, resourceFile);
  if (!await exists(file)) return { version: 1, resources: [] };
  const lock = parseJson(utf8((await regularBytes(file, LIMITS.jsonBytes)).bytes)) as Lock;
  requireValue(lock?.version === 1 && Array.isArray(lock.resources), "E_CONFIG", "Invalid external resource lock");
  lock.resources.forEach(entry => validate(root, entry));
  requireValue(lock.resources.every((entry, index, entries) => entries.every((other, otherIndex) => index === otherIndex
    || !(entry.target.toLowerCase() === other.target.toLowerCase() || entry.target.toLowerCase().startsWith(`${other.target.toLowerCase()}/`)))), "E_CONFIG", "External resource targets overlap");
  return lock;
};
export const manageResources = async (root: string, action: string, input: Readonly<Record<string, string | boolean>>): Promise<Lock> => {
  requireValue(["add", "init", "update"].includes(action), "E_USAGE", "Expected resource add, init or update");
  await safePath(root);
  const mutex = join(root, ".modup-resources-busy");
  try { await mkdir(mutex); } catch { requireValue(false, "E_BUSY", "External resources are already being modified"); }
  try {
    const lock = await readLock(root);
    const requested = action === "add" ? {
      url: String(input.url ?? ""), path: String(input.path ?? "."), target: String(input.target ?? ""),
      ref: String(input.ref ?? "HEAD"), commit: "0".repeat(40), digest: "0".repeat(64), date: new Date(0).toISOString(), tag: null,
    } : null;
    if (requested) {
      validate(root, requested);
      requireValue(lock.resources.every(entry => entry.target.toLowerCase() !== requested.target.toLowerCase()
        && !entry.target.toLowerCase().startsWith(`${requested.target.toLowerCase()}/`)
        && !requested.target.toLowerCase().startsWith(`${entry.target.toLowerCase()}/`)), "E_CONFIG", "External resource target overlaps an existing target");
    }
    const entries = requested ? [...lock.resources, requested] : lock.resources;
    const ignoreFile = join(root, ".gitignore");
    await safePath(ignoreFile, true);
    const ignore = await exists(ignoreFile) ? utf8((await regularBytes(ignoreFile, LIMITS.jsonBytes)).bytes) : "";
    const staging = await mkdtemp(join(await realpath(tmpdir()), "modup-external-"));
    try {
      const prepared = await entries.reduce(async (pending, entry, index) => {
        const previous = await pending;
        const target = childPath(root, entry.target);
        await safePath(target, true);
        const present = await exists(target);
        if (present) {
          requireValue(entry !== requested, "E_INSTALL_CONFLICT", "External resource target already exists", { target: entry.target });
          requireValue((await snapshotLocal(target, "skill")).treeDigest === entry.digest, "E_INSTALL_CONFLICT", "External resource has local modifications", { target: entry.target });
        }
        if ((action === "init" || action === "add" && entry !== requested) && present && entry.date !== undefined && entry.tag !== undefined) return [...previous, { entry, target, staged: null }];
        const repo = join(staging, `repo-${index}`);
        await mkdir(repo);
        await initGit(repo);
        const source = await gitSource(entry.url, root);
        const commit = await fetchCommit(repo, source, action !== "update" && entry !== requested ? entry.commit : entry.ref, source.protocol !== "file");
        const snapshot = await extractTree(repo, commit, entry.path, "skill", source.protocol);
        requireValue(action !== "init" || snapshot.treeDigest === entry.digest, "E_INTEGRITY", "External resource digest differs from lock");
        const date = action === "init" && entry.date !== undefined ? entry.date
          : utf8(await git(repo, ["show", "-s", "--format=%cI", commit])).trim();
        const tags = action === "init" && entry.tag !== undefined ? ""
          : utf8(await git(repo, ["ls-remote", "--tags", "--", source.url], source.protocol));
        const tag = action === "init" && entry.tag !== undefined ? entry.tag : tags.split("\n").flatMap(line => {
          const match = /^([0-9a-f]{40})\trefs\/tags\/(.+?)(?:\^\{\})?$/.exec(line);
          return match?.[1] === commit ? [match[2]!] : [];
        }).sort()[0] ?? null;
        const staged = join(staging, `tree-${index}`);
        await writeSnapshot(snapshot, staged, false);
        return [...previous, { entry: { ...entry, commit, digest: snapshot.treeDigest, date, tag }, target, staged }];
      }, Promise.resolve<readonly { entry: Entry; target: string; staged: string | null }[]>([]));
      const patterns = entries.map(entry => `/${entry.target}/`);
      const extra = patterns.filter(pattern => !ignore.split(/\r?\n/).includes(pattern));
      if (extra.length) await writeFile(ignoreFile, `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}${extra.join("\n")}\n`);
      await prepared.reduce(async (pending, item) => {
        await pending;
        if (!item.staged) return;
        await mkdir(dirname(item.target), { recursive: true });
        const sibling = await mkdtemp(join(dirname(item.target), ".modup-resource-"));
        try {
          // Copy into a sibling before replacement so rename stays on the target filesystem.
          const { cp } = await import("node:fs/promises");
          await cp(item.staged, join(sibling, "new"), { recursive: true });
          const present = await exists(item.target);
          if (present) await rename(item.target, join(sibling, "old"));
          try { await rename(join(sibling, "new"), item.target); }
          catch (error) { if (present) await rename(join(sibling, "old"), item.target); throw error; }
        } finally { await rm(sibling, { recursive: true, force: true }); }
      }, Promise.resolve());
      const result: Lock = { version: 1, resources: prepared.map(item => item.entry) };
      await writeFile(join(mutex, "lock"), `${JSON.stringify(result, null, 2)}\n`);
      await rename(join(mutex, "lock"), join(root, resourceFile));
      return result;
    } finally { await rm(staging, { recursive: true, force: true }); }
  } finally { await rm(mutex, { recursive: true, force: true }); }
};
