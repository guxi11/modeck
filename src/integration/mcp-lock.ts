import { lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { modeError, sha256 } from "../contracts/index.js";
import { atomic, checkDirectory, ensureParents, missing, parentIdentity, safeAbsolute } from "./fs.js";

export const mcpLockPath = (path: string): string => join(dirname(path), `.modeck-mcp-${sha256(Buffer.from(path)).slice(0, 24)}.lock`);

export const assertMcpUnlocked = async (paths: readonly string[], heldPath?: string): Promise<void> => {
  await Promise.all([...new Set(paths)].filter(path => path !== heldPath).map(async path => {
    try { await lstat(mcpLockPath(path)); }
    catch (error) { if (missing(error)) return; throw error; }
    throw modeError("E_BUSY", "MCP shared configuration is locked");
  }));
};

export const withMcpLock = async <T>(path: string, action: () => Promise<T>): Promise<T> => {
  await safeAbsolute(path);
  await ensureParents(dirname(path), path);
  await checkDirectory(dirname(path));
  const lockPath = mcpLockPath(path);
  const parent = await parentIdentity(lockPath);
  const handle = await open(lockPath, "wx", 0o600).catch(() => { throw modeError("E_BUSY", "MCP shared configuration is locked"); });
  const identity = await handle.stat();
  let retain = false;
  try {
    await handle.writeFile(JSON.stringify({ owner: "modeck/mcp/1", pid: process.pid }));
    await handle.close();
    return await action();
  } catch (error) {
    retain = error instanceof Error && "details" in error && (error.details as Record<string, unknown>).retainMcpLock === true;
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
    const current = await lstat(lockPath);
    if (current.ino !== identity.ino || current.dev !== identity.dev) throw modeError("E_INSTALL_CONFLICT", "MCP lock ownership changed");
    if (!retain) await atomic(lockPath, null, parent);
  }
};
