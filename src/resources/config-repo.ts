import { lstat, mkdir, mkdtemp, rename, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonical, LIMITS, modeError } from "../contracts/index.js";
import type { ImportConfigRequest, InitConfigRequest } from "../contracts/index.js";
import { absolute, ensureDirectory, exists, removeTemporary, requireValue, safePath } from "./fs.js";
import { extractTree, fetchCommit, git, gitSource, initGit } from "./git.js";
import { writeSnapshot } from "./tree.js";

const createConfig = async (destination: string, populate: (staging: string) => Promise<void>): Promise<string> => {
  const target = await safePath(absolute(destination), true);
  requireValue(!await exists(target), "E_PATH", "Config destination must not exist", { path: target });
  const parent = await ensureDirectory(dirname(target));
  const staging = await mkdtemp(join(parent, ".modup-config-"));
  try {
    await initGit(staging);
    await populate(staging);
    await safePath(parent);
    // Reserve absence exclusively; rename may replace only this own empty dir.
    await mkdir(target, { mode: 0o700 });
    const reservation = await lstat(target);
    try {
      await safePath(target);
      const current = await lstat(target);
      requireValue(current.ino === reservation.ino && current.dev === reservation.dev,
        "E_PATH", "Config destination changed while publishing");
      await rename(staging, target);
    } catch (error) {
      const current = await lstat(target).catch(() => null);
      if (current?.ino === reservation.ino && current.dev === reservation.dev) await rmdir(target).catch(() => undefined);
      throw error;
    }
    return target;
  } finally { await removeTemporary(staging); }
};

export const initConfig = async ({ destination, initialConfig }: InitConfigRequest): Promise<string> => {
  try {
    return await createConfig(destination, async staging => {
      const text = `${JSON.stringify(JSON.parse(canonical(initialConfig)) as unknown, null, 2)}\n`;
      requireValue(Buffer.byteLength(text) <= LIMITS.jsonBytes, "E_LIMIT", "Initial config exceeds JSON byte limit");
      await writeFile(join(staging, "modes.json"), text, { flag: "wx", mode: 0o644 });
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && String(error.code).startsWith("E_")) throw error;
    throw modeError("E_IO", "Cannot initialize config repository", { cause: String(error) });
  }
};

export const importConfig = async ({ url, ref, destination, validate }: ImportConfigRequest): Promise<string> => {
  const source = await gitSource(url, null);
  try {
    return await createConfig(destination, async staging => {
      const commit = await fetchCommit(staging, source, ref);
      const snapshot = await extractTree(staging, commit, ".", "config");
      await writeSnapshot(snapshot, staging, false);
      await git(staging, ["remote", "add", "origin", source.url]);
      await git(staging, ["update-ref", "refs/heads/main", commit]);
      await git(staging, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      await git(staging, ["read-tree", commit]);
      await validate(staging);
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && String(error.code).startsWith("E_")) throw error;
    throw modeError("E_IO", "Cannot import config repository", { cause: String(error) });
  }
};
