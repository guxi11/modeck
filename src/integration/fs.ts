import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { checkRelativePath, LIMITS, modeError, parseJson, sha256 } from "../contracts/index.js";
import type { FileImage } from "../contracts/index.js";

export const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw modeError("E_CONFIG", "Expected a JSON object");
  return value as Record<string, unknown>;
};
export const data = (image: FileImage): Buffer => Buffer.from(image.data, image.encoding === "utf8" ? "utf8" : "base64");
export const digest = (image: FileImage): string => sha256(data(image));
export const jsonImage = (value: unknown, mode = 0o600): FileImage => ({ data: `${JSON.stringify(value, null, 2)}\n`, encoding: "utf8", mode });
export const imageJson = (image: FileImage): unknown => parseJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data(image)));
export const same = (a: FileImage | null, b: FileImage | null): boolean => a === null || b === null ? a === b : a.mode === b.mode && digest(a) === digest(b);
export const safeAbsolute = async (path: string): Promise<string> => {
  if (!isAbsolute(path) || /\p{Cc}/u.test(path)) throw modeError("E_PATH", "Expected an absolute safe path", { path });
  const target = resolve(path);
  const root = parse(target).root;
  await target.slice(root.length).split("/").filter(Boolean).reduce(async (pending, part) => {
    const parent = await pending;
    const next = join(parent, part);
    try { if ((await lstat(next)).isSymbolicLink()) throw modeError("E_PATH", "Symlink path refused", { path: next }); }
    catch (error) { if (!missing(error)) throw error; }
    return next;
  }, Promise.resolve(root));
  return target;
};
export const homePath = (home: string, path: string): string => { checkRelativePath(path, false); return join(home, path); };
export const readImage = async (path: string, limit: number = LIMITS.fileBytes): Promise<FileImage | null> => {
  await safeAbsolute(path);
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) throw modeError("E_INSTALL_CONFLICT", "Expected a regular file", { path });
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limit || stat.mode & 0o7000) throw modeError("E_INSTALL_CONFLICT", "Unsafe file", { path });
      const bytes = await handle.readFile();
      if (bytes.length > limit) throw modeError("E_LIMIT", "File size limit exceeded", { path });
      return { data: bytes.toString("base64"), encoding: "base64", mode: stat.mode & 0o777 };
    } finally { await handle.close(); }
  } catch (error) { if (missing(error)) return null; throw error; }
};
export const checkDirectory = async (path: string): Promise<void> => {
  await safeAbsolute(path);
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022) {
      throw modeError("E_INSTALL_CONFLICT", "Directory must be owned by this user and not writable by others", { path });
    }
  } catch (error) { if (!missing(error)) throw error; }
};
export const ensureParents = async (home: string, path: string): Promise<readonly string[]> => {
  const parent = dirname(path);
  if (parent === dirname(home)) return [];
  const created = parent === home ? [] : await ensureParents(home, parent);
  try { await mkdir(parent, { mode: 0o700 }); return [...created, parent]; }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    await checkDirectory(parent); return created;
  }
};
export type ParentIdentity = Readonly<{ dev: number; ino: number; realpath: string }>;
export const parentIdentity = async (path: string): Promise<ParentIdentity> => {
  await safeAbsolute(path);
  const parent = dirname(path);
  await checkDirectory(parent);
  const stat = await lstat(parent);
  return { dev: stat.dev, ino: stat.ino, realpath: await realpath(parent) };
};
const verifyParent = async (path: string, expected: ParentIdentity): Promise<void> => {
  const current = await parentIdentity(path);
  if (current.dev !== expected.dev || current.ino !== expected.ino || current.realpath !== expected.realpath) {
    throw modeError("E_PLAN_STALE", "Destination parent directory changed", { path });
  }
};
export const atomic = async (path: string, image: FileImage | null, expectedParent?: ParentIdentity): Promise<ParentIdentity> => {
  const parent = expectedParent ?? await parentIdentity(path);
  await verifyParent(path, parent);
  if (image === null) { await unlink(path); return parent; }
  const temp = join(dirname(path), `.agent-modes-${randomUUID()}`);
  const handle = await open(temp, "wx", 0o600);
  const temporary = await handle.stat();
  try {
    await handle.writeFile(data(image)); await handle.chmod(image.mode); await handle.close();
    await verifyParent(path, parent);
    await rename(temp, path);
    return parent;
  } catch (error) {
    await handle.close().catch(() => undefined);
    // A replaced parent may contain someone else's same-named file; leave it untouched.
    await (async () => {
      await verifyParent(path, parent);
      const current = await lstat(temp);
      if (current.dev === temporary.dev && current.ino === temporary.ino) await unlink(temp);
    })().catch(() => undefined);
    throw error;
  }
};
export const treeFiles = async (root: string, prefix = ""): Promise<readonly string[]> => {
  if (prefix) checkRelativePath(prefix, false);
  const directory = join(root, prefix);
  await safeAbsolute(directory);
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (missing(error)) return []; throw error;
  });
  return (await Promise.all(entries.map(async entry => {
    const path = entry.name;
    checkRelativePath(path, false);
    if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) throw modeError("E_PATH", "Unsafe tree entry", { path });
    return entry.isDirectory() ? (await treeFiles(directory, path)).map(child => `${path}/${child}`) : [path];
  }))).flat().sort();
};
