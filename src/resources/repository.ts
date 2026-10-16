import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { canonical, LIMITS, modeError, sha256 } from "../contracts/index.js";
import type {
  ConfigContext, LockedResource, ReadResourcesRequest, ResourceLock, ResourceSpec,
  SyncResourcesRequest, VerifiedResource, VerifiedResourceSet,
} from "../contracts/index.js";
import { childPath, compare, ensureDirectory, exists, missing, removeTemporary, requireValue, safePath } from "./fs.js";
import { extractTree, fetchCommit, gitSource, initGit } from "./git.js";
import { makeLock, readLock, validateContext, validateLock, withConfigLock, writeLock } from "./lock.js";
import { resourceEntry, validateNames } from "./skill.js";
import { matchesLock, objectPath, publishObject, readObject } from "./store.js";
import { snapshotLocal } from "./tree.js";
import type { Snapshot } from "./tree.js";

const localSnapshot = async (context: ConfigContext, spec: ResourceSpec, locked: LockedResource | null): Promise<Snapshot> => {
  try {
    const source = await safePath(childPath(context.configRoot, spec.source.path, spec.kind === "skill"));
    // A tree containing our own mutable lock cannot have a reproducible identity.
    requireValue(!(spec.kind === "skill" && source === context.configRoot)
      && ![join(context.configRoot, "modes.lock.json"), join(context.configRoot, ".modup-sync.lock")].includes(source),
    "E_PATH", "Local resource must not include the configuration lock; use a dedicated skill directory");
    return await snapshotLocal(source, spec.kind);
  }
  catch (error) {
    if (missing(error)) throw modeError(locked ? "E_LOCK_MISMATCH" : "E_RESOURCE_MISSING", "Local resource is missing", { id: locked?.id ?? null });
    throw error;
  }
};

const checkLocal = async (context: ConfigContext, locked: LockedResource): Promise<void> => {
  const spec = context.config.resources[locked.id]!;
  if (spec.source.type !== "local") return;
  const snapshot = await localSnapshot(context, spec, locked);
  requireValue(matchesLock(snapshot, locked), "E_LOCK_MISMATCH", "Local resource changed; use sync --update", { id: locked.id });
};

const gitSnapshot = async (context: ConfigContext, stateRoot: string, spec: ResourceSpec,
  pinned: string | null): Promise<{ readonly snapshot: Snapshot; readonly commit: string }> => {
  requireValue(spec.source.type === "git", "E_CONFIG", "Expected a Git resource");
  if (spec.source.type !== "git") throw modeError("E_CONFIG", "Expected a Git resource");
  const source = await gitSource(spec.source.url, context.configRoot);
  const work = await ensureDirectory(join(stateRoot, ".work"));
  const temporary = await mkdtemp(join(work, "git-"));
  try {
    await initGit(temporary);
    const commit = await fetchCommit(temporary, source, spec.source.ref, pinned);
    const snapshot = await extractTree(temporary, commit, spec.source.path, spec.kind);
    return { snapshot, commit };
  } finally { await removeTemporary(temporary); }
};

const lockResource = (id: string, spec: ResourceSpec, snapshot: Snapshot, commit: string | null): LockedResource => ({
  id, kind: spec.kind, sourceDigest: sha256(Buffer.from(canonical(spec))), commit,
  treeDigest: snapshot.treeDigest, entries: snapshot.entries,
});

const synchronized = async (context: ConfigContext, stateRoot: string, id: string, spec: ResourceSpec,
  existing: LockedResource | null): Promise<{ readonly locked: LockedResource; readonly verified: VerifiedResource }> => {
  if (spec.source.type === "git" && existing && await exists(objectPath(stateRoot, existing.treeDigest))) {
    return { locked: existing, verified: await readObject(stateRoot, existing) };
  }
  const fetched = spec.source.type === "git" ? await gitSnapshot(context, stateRoot, spec, existing?.commit ?? null)
    : { snapshot: await localSnapshot(context, spec, existing), commit: null };
  if (existing) requireValue(matchesLock(fetched.snapshot, existing), "E_LOCK_MISMATCH",
    "Fetched/local resource content differs from its lock", { id });
  resourceEntry(fetched.snapshot, spec.kind);
  const locked = existing ?? lockResource(id, spec, fetched.snapshot, fetched.commit);
  return { locked, verified: await publishObject(stateRoot, locked, fetched.snapshot) };
};

const result = (context: ConfigContext, lock: ResourceLock, resources: readonly VerifiedResource[]): VerifiedResourceSet => {
  validateNames(resources);
  const total = lock.resources.reduce((sum, resource) => sum + resource.entries.reduce((size, entry) => size + (entry.kind === "file" ? entry.bytes : 0), 0), 0);
  requireValue(total <= LIMITS.allResourceBytes, "E_LIMIT", "Total resource byte limit exceeded");
  return Object.freeze({ schemaVersion: 1 as const, configDigest: context.configDigest, lock,
    lockDigest: sha256(Buffer.from(canonical(lock))), resources: Object.freeze([...resources]) });
};

const resourceFailure = (error: unknown): never => {
  if (error instanceof Error && "code" in error && String(error.code).startsWith("E_")) throw error;
  throw modeError("E_IO", "Resource operation failed", { cause: String(error) });
};

export const readResources = async ({ context, stateRoot: requestedState, parseLock }: ReadResourcesRequest): Promise<VerifiedResourceSet> => {
  try {
    const stateRoot = await safePath(requestedState, true);
    await validateContext(context, stateRoot);
    const existing = await readLock(context.configRoot, parseLock);
    requireValue(existing.lock, "E_LOCK_MISSING", "Resource lock is missing; run sync");
    const lock = existing.lock!;
    validateLock(context, lock);
    const resources = await lock.resources.reduce(async (pending, locked) => {
      const current = await pending;
      await checkLocal(context, locked);
      return [...current, await readObject(stateRoot, locked)];
    }, Promise.resolve([] as readonly VerifiedResource[]));
    await validateContext(context, stateRoot);
    return result(context, lock, resources);
  } catch (error) { return resourceFailure(error); }
};

export const syncResources = async ({ context, stateRoot: requestedState, mode, parseLock }: SyncResourcesRequest): Promise<VerifiedResourceSet> => {
  try {
    const stateRoot = await safePath(requestedState, true);
    requireValue(["reuse", "update", "frozen"].includes(mode), "E_USAGE", "Invalid sync mode");
    await validateContext(context, stateRoot);
    return await withConfigLock(context.configRoot, async () => {
      const previous = await readLock(context.configRoot, parseLock);
      requireValue(mode !== "frozen" || previous.lock, "E_LOCK_MISSING", "Frozen sync requires an existing lock");
      if (previous.lock && mode !== "update") validateLock(context, previous.lock);
      await ensureDirectory(stateRoot);
      const old = new Map(previous.lock?.resources.map(resource => [resource.id, resource]));
      const resources = await Object.entries(context.config.resources).sort(([a], [b]) => compare(a, b))
        .reduce(async (pending, [id, spec]) => {
          const current = await pending;
          const entry = await synchronized(context, stateRoot, id, spec, mode === "update" ? null : old.get(id) ?? null);
          return [...current, entry];
        }, Promise.resolve([] as readonly { readonly locked: LockedResource; readonly verified: VerifiedResource }[]));
      const lock = previous.lock && mode !== "update" ? previous.lock : makeLock(context, resources.map(entry => entry.locked), parseLock);
      const verified = result(context, lock, resources.map(entry => entry.verified));
      // A slow Git fetch must not hide local changes made since the first scan.
      await lock.resources.reduce(async (pending, locked) => { await pending; await checkLocal(context, locked); }, Promise.resolve());
      await validateContext(context, stateRoot);
      if (!previous.lock || mode === "update") await writeLock(context, stateRoot, previous, lock);
      else {
        const current = await readLock(context.configRoot, parseLock);
        requireValue(current.bytes && sha256(current.bytes) === sha256(previous.bytes!), "E_LOCK_MISMATCH", "Lock changed during sync");
      }
      return verified;
    });
  } catch (error) { return resourceFailure(error); }
};
