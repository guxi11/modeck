import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { checkRelativePath, modeError } from "../contracts/index.js";
import type { ModeErrorCode } from "../contracts/index.js";

export const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
export const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const hashPattern = /^[0-9a-f]{64}$/;
export const commitPattern = /^[0-9a-f]{40}$/;

export const requireValue = (condition: unknown, code: ModeErrorCode, message: string,
  details: Readonly<Record<string, unknown>> = {}): void => {
  if (!condition) throw modeError(code, message, details);
};

export const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return !rel || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};

export const absolute = (path: string): string => {
  requireValue(isAbsolute(path), "E_PATH", "Expected an explicit absolute path", { path });
  return resolve(path);
};

export const safePath = async (path: string, allowMissing = false): Promise<string> => {
  const target = absolute(path);
  const root = parse(target).root;
  const walked = await target.slice(root.length).split(sep).filter(Boolean).reduce(async (pending, part) => {
    const parent = await pending;
    const next = join(parent, part);
    try {
      const info = await lstat(next);
      requireValue(!info.isSymbolicLink(), "E_PATH", "Symlink path is not allowed", { path: next });
      return await realpath(next);
    } catch (error) { if (!allowMissing || !missing(error)) throw error; }
    return next;
  }, Promise.resolve(root));
  try { return await realpath(walked); }
  catch (error) { if (allowMissing && missing(error)) return walked; throw error; }
};

export const childPath = (root: string, path: string, allowRoot = false): string => {
  checkRelativePath(path, allowRoot);
  const child = resolve(root, path);
  requireValue(within(root, child), "E_PATH", "Path escapes its resource root", { path });
  return child;
};

export const ensureDirectory = async (path: string): Promise<string> => {
  const target = await safePath(path, true);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await safePath(target);
  requireValue((await lstat(target)).isDirectory(), "E_PATH", "Expected a directory", { path });
  return target;
};

export const regularBytes = async (path: string, limit: number): Promise<{ readonly bytes: Buffer; readonly executable: boolean }> => {
  await safePath(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    requireValue(before.isFile(), "E_PATH", "Expected a regular resource file", { path });
    requireValue(before.size <= limit, "E_LIMIT", "File exceeds byte limit", { path, limit });
    const bytes = await handle.readFile();
    const after = await handle.stat();
    requireValue(bytes.length <= limit, "E_LIMIT", "File exceeds byte limit", { path, limit });
    requireValue(before.size === after.size && before.ino === after.ino && before.dev === after.dev
      && (before.mode & 0o111) === (after.mode & 0o111), "E_INTEGRITY", "File changed while reading", { path });
    return { bytes, executable: (after.mode & 0o111) !== 0 };
  } finally { await handle.close(); }
};

export const utf8 = (bytes: Uint8Array): string => {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw modeError("E_INTEGRITY", "Resource contains invalid UTF-8"); }
};

export const exists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; }
  catch (error) { if (missing(error)) return false; throw error; }
};

export const removeTemporary = async (path: string): Promise<void> => {
  // Only tool-created staging directories reach this cleanup; never follow links.
  const writable = async (directory: string): Promise<void> => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    await chmod(directory, 0o700);
    await (await readdir(directory)).reduce(async (pending, name) => {
      await pending;
      await writable(join(directory, name));
    }, Promise.resolve());
  };
  if (!await exists(path)) return;
  await writable(path);
  await rm(path, { recursive: true, force: true });
};
