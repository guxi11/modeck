import { chmod, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { canonical, checkRelativePath, LIMITS, sha256 } from "../contracts/index.js";
import type { Kind, TreeEntry } from "../contracts/index.js";
import { childPath, compare, regularBytes, requireValue, safePath } from "./fs.js";

export type FileData = { readonly path: string; readonly bytes: Uint8Array; readonly executable: boolean };
export type Snapshot = { readonly entries: readonly TreeEntry[]; readonly files: ReadonlyMap<string, FileData>; readonly treeDigest: string };

export const treeDigest = (entries: readonly TreeEntry[]): string => sha256(Buffer.from(`agent-modes-tree-v1\n${canonical(entries)}`));

export const validateEntries = (entries: readonly TreeEntry[], maxEntries: number = LIMITS.treeEntries,
  maxBytes: number = LIMITS.treeBytes): void => {
  requireValue(entries.length <= maxEntries, "E_LIMIT", "Resource entry limit exceeded", { maxEntries });
  const paths = entries.map(entry => entry.path);
  const map = new Map(entries.map(entry => [entry.path, entry]));
  requireValue(new Set(paths.map(path => path.toLowerCase())).size === paths.length,
    "E_INTEGRITY", "Tree paths collide under case folding");
  const bytes = entries.reduce((sum, entry, index) => {
    checkRelativePath(entry.path, false);
    requireValue(index === 0 || compare(paths[index - 1]!, entry.path) < 0,
      "E_INTEGRITY", "Tree paths must be unique and sorted");
    const parent = posix.dirname(entry.path);
    requireValue(parent === "." || map.get(parent)?.kind === "directory", "E_INTEGRITY", "Tree parent is missing", { path: entry.path });
    if (entry.kind === "directory") return sum;
    requireValue(entry.kind === "file" && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0
      && entry.bytes <= LIMITS.fileBytes && /^[0-9a-f]{64}$/.test(entry.digest)
      && typeof entry.executable === "boolean", "E_INTEGRITY", "Invalid tree file", { path: entry.path });
    return sum + entry.bytes;
  }, 0);
  requireValue(bytes <= maxBytes, "E_LIMIT", "Resource tree byte limit exceeded", { maxBytes });
};

export const fromFiles = (directories: readonly string[], files: readonly FileData[],
  maxEntries: number = LIMITS.treeEntries, maxBytes: number = LIMITS.treeBytes): Snapshot => {
  const entries: readonly TreeEntry[] = [
    ...directories.map(path => ({ path, kind: "directory" as const })),
    ...files.map(file => ({ path: file.path, kind: "file" as const,
      digest: sha256(file.bytes), bytes: file.bytes.byteLength, executable: file.executable })),
  ].sort((a, b) => compare(a.path, b.path));
  validateEntries(entries, maxEntries, maxBytes);
  return { entries, files: new Map(files.map(file => [file.path, file])), treeDigest: treeDigest(entries) };
};

type Collected = { readonly directories: readonly string[]; readonly files: readonly FileData[]; readonly bytes: number };

export const snapshotLocal = async (root: string, kind: Kind): Promise<Snapshot> => {
  await safePath(root);
  const info = await lstat(root);
  if (kind === "rule") {
    requireValue(info.isFile(), "E_PATH", "Rule source must be a file", { path: root });
    const file = await regularBytes(root, LIMITS.textFileBytes);
    return fromFiles([], [{ path: "content.md", ...file }]);
  }
  requireValue(info.isDirectory(), "E_PATH", "Skill source must be a directory", { path: root });
  const walk = async (relative: string, depth: number, state: Collected): Promise<Collected> => {
    requireValue(depth <= LIMITS.scanDepth, "E_LIMIT", "Resource directory depth exceeded");
    const directory = relative ? childPath(root, relative) : root;
    await safePath(directory);
    const names = (await readdir(directory)).sort(compare);
    requireValue(state.directories.length + state.files.length + names.length <= LIMITS.treeEntries,
      "E_LIMIT", "Resource entry limit exceeded");
    return names.reduce(async (pending, name) => {
      const current = await pending;
      requireValue(current.directories.length + current.files.length < LIMITS.treeEntries,
        "E_LIMIT", "Resource entry limit exceeded");
      const path = relative ? `${relative}/${name}` : name;
      const full = childPath(root, path);
      const stat = await lstat(full);
      requireValue(!stat.isSymbolicLink(), "E_PATH", "Symlinks are not allowed in resources", { path: full });
      if (stat.isDirectory()) return walk(path, depth + 1,
        { ...current, directories: [...current.directories, path] });
      requireValue(stat.isFile(), "E_PATH", "Only regular files and directories are allowed", { path: full });
      const file = await regularBytes(full, path === "SKILL.md" ? LIMITS.textFileBytes : LIMITS.fileBytes);
      const bytes = current.bytes + file.bytes.length;
      requireValue(bytes <= LIMITS.treeBytes, "E_LIMIT", "Resource tree byte limit exceeded");
      return { ...current, bytes, files: [...current.files, { path, ...file }] };
    }, Promise.resolve(state));
  };
  const data = await walk("", 0, { directories: [], files: [], bytes: 0 });
  return fromFiles(data.directories, data.files);
};

export const writeSnapshot = async (snapshot: Snapshot, root: string, readonly: boolean): Promise<void> => {
  await safePath(root, true);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directories = snapshot.entries.filter(entry => entry.kind === "directory");
  await directories.reduce(async (pending, entry) => {
    await pending;
    await mkdir(childPath(root, entry.path), { mode: 0o700 });
  }, Promise.resolve());
  await [...snapshot.files.values()].reduce(async (pending, file) => {
    await pending;
    const path = childPath(root, file.path);
    const mode = file.executable ? readonly ? 0o555 : 0o755 : readonly ? 0o444 : 0o644;
    await writeFile(path, file.bytes, { flag: "wx", mode });
    await chmod(path, mode);
  }, Promise.resolve());
  await [...directories].reverse().reduce(async (pending, entry) => {
    await pending;
    await chmod(join(root, entry.path), readonly ? 0o555 : 0o755);
  }, Promise.resolve());
  await chmod(root, readonly ? 0o555 : 0o700);
};
