import { lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { canonical, LIMITS, modeError, sha256 } from "../contracts/index.js";
import type { ConfigContext } from "../contracts/index.js";
import { missing, regularBytes, requireValue, safePath, within } from "./fs.js";

export const validateContext = async (context: ConfigContext, stateRoot: string): Promise<void> => {
  const root = await safePath(context.configRoot);
  const state = await safePath(stateRoot, true);
  requireValue(!within(root, state), "E_PATH", "State must be outside the shared config directory");
  const { bytes } = await regularBytes(join(context.configRoot, "modes.json"), LIMITS.jsonBytes);
  requireValue(sha256(bytes) === context.rawConfigDigest && sha256(Buffer.from(canonical(context.config))) === context.configDigest,
    "E_LOCK_MISMATCH", "Configuration changed after it was loaded");
};

export const withConfigLock = async <T>(root: string, operation: () => Promise<T>): Promise<T> => {
  const path = join(root, ".modup-sync.lock");
  await safePath(root);
  const handle = await open(path, "wx", 0o600).catch(error => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw modeError("E_BUSY", "Config sync is already locked", { path });
    throw error;
  });
  const own = await handle.stat();
  try {
    await handle.writeFile(`${canonical({ schemaVersion: 1, owner: "modup/v1", pid: process.pid })}\n`);
    await handle.sync();
    return await operation();
  } finally {
    await handle.close();
    const now = await lstat(path).catch(error => { if (missing(error)) return null; throw error; });
    if (now && now.ino === own.ino && now.dev === own.dev) await unlink(path);
  }
};
