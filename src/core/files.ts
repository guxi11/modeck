import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { modeError, parseJson } from "../contracts/index.js";
import type { ModeErrorCode } from "../contracts/index.js";

export const isMissing = (error: unknown): boolean => error instanceof Error
  && "code" in error && error.code === "ENOENT";

export const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};

export const absolute = (path: string): string => {
  if (!isAbsolute(path)) throw modeError("E_PATH", "Expected an explicit absolute path", { path });
  return resolve(path);
};

export const safePath = async (path: string): Promise<string> => {
  const target = absolute(path);
  const root = parse(target).root;
  const parts = target.slice(root.length).split(sep).filter(Boolean);
  await parts.reduce(async (pending, part) => {
    const parent = await pending;
    const next = resolve(parent, part);
    const info = await lstat(next);
    if (info.isSymbolicLink()) throw modeError("E_PATH", "Symlink path is not allowed", { path: next });
    return next;
  }, Promise.resolve(root));
  return realpath(target);
};

export const readJsonFile = async (path: string, limit: number, code: ModeErrorCode):
Promise<{ readonly value: unknown; readonly bytes: Buffer }> => {
  try {
    await safePath(dirname(path));
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw modeError(code, "Expected a regular JSON file", { path });
      if (stat.size > limit) throw modeError("E_LIMIT", "JSON byte limit exceeded", { path, limit });
      const bytes = await handle.readFile();
      if (bytes.length > limit) throw modeError("E_LIMIT", "JSON byte limit exceeded", { path, limit });
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      return { value: parseJson(text), bytes };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("E_")) {
      if (error.code !== "E_CONFIG") throw error;
    }
    throw modeError(code, "Cannot read valid JSON", { path, cause: String(error) });
  }
};
