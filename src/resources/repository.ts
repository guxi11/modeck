import { mkdtemp, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonical, LIMITS, modeError, parseJson, sha256 } from "../contracts/index.js";
import type {
  ConfigContext, LockedResource, ReadResourcesRequest, ResourceLock, ResourceSpec,
  SyncResourcesRequest, VerifiedResource, VerifiedResourceSet,
} from "../contracts/index.js";
import { childPath, compare, ensureDirectory, exists, missing, regularBytes, removeTemporary, requireValue, safePath, utf8 } from "./fs.js";
import { extractTree, fetchCommit, gitSource, initGit } from "./git.js";
import { validateContext } from "./lock.js";
import { resourceEntry, validateNames } from "./skill.js";
import { publishObject, readObject } from "./store.js";
import { snapshotLocal } from "./tree.js";
import type { Snapshot } from "./tree.js";

const digest = (value: unknown): string => sha256(Buffer.from(canonical(value)));

const localSnapshot = async (context: ConfigContext, spec: ResourceSpec): Promise<Snapshot> => {
  try {
    const source = await safePath(childPath(context.configRoot, spec.source.path, spec.kind === "skill"));
    requireValue(!(spec.kind === "skill" && source === context.configRoot),
      "E_PATH", "Local skills require a dedicated directory");
    return await snapshotLocal(source, spec.kind);
  } catch (error) {
    if (missing(error)) throw modeError("E_RESOURCE_MISSING", "Local resource is missing", { path: spec.source.path });
    throw error;
  }
};

const gitSnapshot = async (context: ConfigContext, stateRoot: string, spec: ResourceSpec):
Promise<{ readonly snapshot: Snapshot; readonly commit: string }> => {
  if (spec.source.type !== "git") throw modeError("E_CONFIG", "Expected a Git resource");
  const source = await gitSource(spec.source.url, context.configRoot);
  const work = await ensureDirectory(join(stateRoot, ".work"));
  const temporary = await mkdtemp(join(work, "git-"));
  try {
    await initGit(temporary);
    const commit = await fetchCommit(temporary, source, spec.source.ref);
    return { snapshot: await extractTree(temporary, commit, spec.source.path, spec.kind), commit };
  } finally { await removeTemporary(temporary); }
};

// Git descriptors are cached outside the shared repository, scoped to their source root.
const cachePath = (context: ConfigContext, stateRoot: string, id: string, spec: ResourceSpec): string =>
  join(stateRoot, "git", `${digest({ configRoot: context.configRoot, id, spec })}.json`);

const cachedGit = async (request: ReadResourcesRequest, stateRoot: string, id: string, spec: ResourceSpec): Promise<LockedResource | null> => {
  const path = cachePath(request.context, stateRoot, id, spec);
  if (!await exists(path)) return null;
  const { bytes } = await regularBytes(path, LIMITS.lockBytes);
  const manifest = request.parseLock(parseJson(utf8(bytes)));
  const resource = manifest.resources[0];
  requireValue(manifest.resources.length === 1 && resource?.id === id && resource.kind === spec.kind
    && resource.sourceDigest === digest(spec) && resource.commit !== null
    && manifest.resourceSpecDigest === digest({ [id]: spec }), "E_INTEGRITY", "Git cache does not match its resource", { id });
  return resource!;
};

const cacheGit = async (context: ConfigContext, stateRoot: string, id: string, spec: ResourceSpec, locked: LockedResource): Promise<void> => {
  const directory = await ensureDirectory(join(stateRoot, "git"));
  const temporary = join(directory, `.stage-${randomUUID()}`);
  const manifest: ResourceLock = { schemaVersion: 1, resourceSpecDigest: digest({ [id]: spec }), resources: [locked] };
  const bytes = Buffer.from(`${canonical(manifest)}\n`);
  requireValue(bytes.length <= LIMITS.lockBytes, "E_LIMIT", "Git cache manifest exceeds byte limit");
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await safePath(directory);
    await rename(temporary, cachePath(context, stateRoot, id, spec));
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
};

type ResourceImage = { readonly locked: LockedResource; readonly verified: VerifiedResource };
const resourceImage = async (request: ReadResourcesRequest, stateRoot: string, id: string, spec: ResourceSpec,
  sync: "reuse" | "update" | null): Promise<ResourceImage> => {
  if (spec.source.type === "git" && sync !== "update") {
    const cached = await cachedGit(request, stateRoot, id, spec);
    if (cached) return { locked: cached, verified: await readObject(stateRoot, cached) };
    requireValue(sync !== null, "E_RESOURCE_MISSING", "Git resource is not cached; run modup sync", { id });
  }
  const fetched = spec.source.type === "git" ? await gitSnapshot(request.context, stateRoot, spec)
    : { snapshot: await localSnapshot(request.context, spec), commit: null };
  resourceEntry(fetched.snapshot, spec.kind);
  const locked: LockedResource = { id, kind: spec.kind, sourceDigest: digest(spec), commit: fetched.commit,
    treeDigest: fetched.snapshot.treeDigest, entries: fetched.snapshot.entries };
  const verified = await publishObject(stateRoot, locked, fetched.snapshot);
  if (spec.source.type === "git") await cacheGit(request.context, stateRoot, id, spec, locked);
  return { locked, verified };
};

const resourcesFor = async (request: ReadResourcesRequest, sync: "reuse" | "update" | null): Promise<VerifiedResourceSet> => {
  try {
    const { context } = request;
    const stateRoot = await safePath(request.stateRoot, true);
    await validateContext(context, stateRoot);
    const ids = [...new Set(request.resourceIds ?? Object.keys(context.config.resources))].sort(compare);
    const images = await ids.reduce(async (pending, id) => {
      const current = await pending;
      const spec = context.config.resources[id];
      requireValue(spec, "E_CONFIG", "Unknown requested resource", { id });
      return [...current, await resourceImage(request, stateRoot, id, spec!, sync)];
    }, Promise.resolve([] as readonly ResourceImage[]));
    const resources = images.map(image => image.verified);
    validateNames(resources);
    // This in-memory manifest describes bytes just read; no repository version lock exists.
    const lock = request.parseLock({ schemaVersion: 1, resourceSpecDigest: digest(context.config.resources),
      resources: images.map(image => image.locked) });
    requireValue(Buffer.byteLength(canonical(lock)) <= LIMITS.lockBytes, "E_LIMIT", "Resource manifest exceeds byte limit");
    await validateContext(context, stateRoot);
    return Object.freeze({ schemaVersion: 1 as const, configDigest: context.configDigest,
      lock, lockDigest: digest(lock), resources: Object.freeze(resources) });
  } catch (error) {
    if (error instanceof Error && "code" in error && String(error.code).startsWith("E_")) throw error;
    throw modeError("E_IO", "Resource operation failed", { cause: String(error) });
  }
};

export const readResources = async (request: ReadResourcesRequest): Promise<VerifiedResourceSet> => resourcesFor(request, null);

export const syncResources = async (request: SyncResourcesRequest): Promise<VerifiedResourceSet> => {
  requireValue(request.mode === "reuse" || request.mode === "update", "E_USAGE",
    "Frozen sync is unsupported without a modup version lock; manage versions in Git or your package manager");
  return resourcesFor(request, request.mode === "update" ? "update" : "reuse");
};
