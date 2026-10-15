import { lstat, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonical, LIMITS, modeError, parseJson, sha256 } from "../contracts/index.js";
import type { ConfigContext, LockedResource, LockParser, ResourceLock } from "../contracts/index.js";
import { commitPattern, compare, exists, missing, regularBytes, requireValue, safePath, utf8, within } from "./fs.js";
import { treeDigest, validateEntries } from "./tree.js";

export type ExistingLock = { readonly lock: ResourceLock | null; readonly bytes: Uint8Array | null };

export const validateContext = async (context: ConfigContext, stateRoot: string): Promise<void> => {
  const root = await safePath(context.configRoot);
  const state = await safePath(stateRoot, true);
  requireValue(!within(root, state), "E_PATH", "State must be outside the shared config directory");
  const { bytes } = await regularBytes(join(context.configRoot, "modes.json"), LIMITS.jsonBytes);
  requireValue(sha256(bytes) === context.rawConfigDigest && sha256(Buffer.from(canonical(context.config))) === context.configDigest,
    "E_LOCK_MISMATCH", "Configuration changed after it was loaded");
};

export const readLock = async (root: string, parseLock: LockParser): Promise<ExistingLock> => {
  const path = join(root, "modes.lock.json");
  try {
    await safePath(path);
    const { bytes } = await regularBytes(path, LIMITS.lockBytes);
    return { bytes, lock: parseLock(parseJson(utf8(bytes))) };
  } catch (error) {
    if (missing(error)) return { lock: null, bytes: null };
    if (error instanceof Error && "code" in error && error.code === "E_CONFIG") {
      throw modeError("E_LOCK_MISMATCH", "Lock JSON is invalid", { path });
    }
    throw error;
  }
};

export const validateLock = (context: ConfigContext, lock: ResourceLock): void => {
  const expected = Object.keys(context.config.resources).sort(compare);
  requireValue(lock.resourceSpecDigest === sha256(Buffer.from(canonical(context.config.resources)))
    && canonical(lock.resources.map(resource => resource.id)) === canonical(expected),
  "E_LOCK_MISMATCH", "Resource descriptions or resource set differ from the lock; use sync --update");
  lock.resources.forEach(resource => {
    const spec = context.config.resources[resource.id]!;
    requireValue(resource.kind === spec.kind && resource.sourceDigest === sha256(Buffer.from(canonical(spec)))
      && (spec.source.type === "local" ? resource.commit === null : typeof resource.commit === "string" && commitPattern.test(resource.commit)),
    "E_LOCK_MISMATCH", "Resource source or commit differs from its lock", { id: resource.id });
    validateEntries(resource.entries);
    requireValue(resource.treeDigest === treeDigest(resource.entries), "E_LOCK_MISMATCH", "Locked tree digest is invalid", { id: resource.id });
  });
};

export const makeLock = (context: ConfigContext, resources: readonly LockedResource[], parseLock: LockParser): ResourceLock => {
  const lock = parseLock({ schemaVersion: 1,
    resourceSpecDigest: sha256(Buffer.from(canonical(context.config.resources))), resources });
  requireValue(Buffer.byteLength(canonical(lock)) <= LIMITS.lockBytes, "E_LIMIT", "Resource lock exceeds byte limit");
  validateLock(context, lock);
  return lock;
};

export const withConfigLock = async <T>(root: string, operation: () => Promise<T>): Promise<T> => {
  const path = join(root, ".agent-modes-sync.lock");
  await safePath(root);
  const handle = await open(path, "wx", 0o600).catch(error => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw modeError("E_BUSY", "Config sync is already locked", { path });
    throw error;
  });
  const own = await handle.stat();
  try {
    await handle.writeFile(`${canonical({ schemaVersion: 1, owner: "agent-modes/v1", pid: process.pid })}\n`);
    await handle.sync();
    return await operation();
  } finally {
    await handle.close();
    const now = await lstat(path).catch(error => { if (missing(error)) return null; throw error; });
    if (now && now.ino === own.ino && now.dev === own.dev) await unlink(path);
  }
};

export const writeLock = async (context: ConfigContext, stateRoot: string, previous: ExistingLock,
  lock: ResourceLock): Promise<void> => {
  const path = join(context.configRoot, "modes.lock.json");
  const unchanged = async (): Promise<void> => {
    await validateContext(context, stateRoot);
    const current = await exists(path) ? (await regularBytes(path, LIMITS.lockBytes)).bytes : null;
    requireValue((current === null) === (previous.bytes === null)
      && (current === null || sha256(current) === sha256(previous.bytes!)), "E_LOCK_MISMATCH", "Lock changed during sync");
  };
  await unchanged();
  const text = `${JSON.stringify(JSON.parse(canonical(lock)) as unknown, null, 2)}\n`;
  requireValue(Buffer.byteLength(text) <= LIMITS.lockBytes, "E_LIMIT", "Formatted lock exceeds byte limit");
  const temporary = join(context.configRoot, `.modes.lock-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    await safePath(context.configRoot);
    await unchanged();
    await rename(temporary, path);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(error => { if (!missing(error)) throw error; });
  }
};
