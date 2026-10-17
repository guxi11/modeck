import { mkdtemp, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonical, LIMITS, modeError, parseJson, sha256, useResourcePath } from "../contracts/index.js";
import type {
  ConfigContext, Kind, ManifestResource, ReadResourcesRequest, ResourceManifest, ResourceSpec,
  SyncResourcesRequest, VerifiedResource, VerifiedResourceSet,
} from "../contracts/index.js";
import { childPath, commitPattern, compare, ensureDirectory, exists, hashPattern, missing, regularBytes, removeTemporary, requireValue, safePath, utf8 } from "./fs.js";
import { extractTree, fetchCommit, gitSource, initGit } from "./git.js";
import { validateContext } from "./manifest.js";
import { resourceEntry, validateNames } from "./skill.js";
import { publishObject, readObject } from "./store.js";
import { snapshotLocal } from "./tree.js";
import type { Snapshot } from "./tree.js";

const digest = (value: unknown): string => sha256(Buffer.from(canonical(value)));

const localSnapshot = async (context: ConfigContext, id: string, spec: ResourceSpec): Promise<Snapshot> => {
  const path = spec.source.type === "use" ? useResourcePath(id, spec.kind) : spec.source.path;
  try {
    const source = await safePath(childPath(context.configRoot, path, spec.kind === "skill"));
    requireValue(!(spec.kind === "skill" && source === context.configRoot),
      "E_PATH", "Local skills require a dedicated directory");
    return await snapshotLocal(source, spec.kind);
  } catch (error) {
    if (missing(error)) throw modeError("E_RESOURCE_MISSING", spec.source.type === "use"
      ? "Installed resource is missing; run modeck res init" : "Local resource is missing", { path });
    throw error;
  }
};

type InstalledEntry = Readonly<{ id?: string; kind?: Kind; url: string; path: string;
  target: string; commit: string; digest: string }>;
const installedSnapshot = async (context: ConfigContext, id: string, spec: ResourceSpec):
Promise<{ readonly snapshot: Snapshot; readonly commit: string }> => {
  if (spec.source.type !== "use") throw modeError("E_CONFIG", "Expected an installed resource");
  let lock: { readonly version?: unknown; readonly resources?: unknown };
  try {
    lock = parseJson(utf8((await regularBytes(join(context.configRoot, "modeck-lock.json"), LIMITS.jsonBytes)).bytes)) as typeof lock;
  } catch (error) {
    if (missing(error)) throw modeError("E_RESOURCE_MISSING", "Resource lock is missing; run modeck res init", { id });
    throw error;
  }
  requireValue(lock?.version === 1 && Array.isArray(lock.resources) && lock.resources.length <= LIMITS.resources,
    "E_CONFIG", "Invalid resource lock; run modeck res init");
  const entries = lock.resources as readonly InstalledEntry[];
  requireValue(entries.every(entry => entry && typeof entry === "object"
    && [entry.url, entry.path, entry.target].every(value => typeof value === "string" && value.length > 0)
    && (entry.kind === undefined || entry.kind === "rule" || entry.kind === "skill")
    && typeof entry.commit === "string" && commitPattern.test(entry.commit)
    && typeof entry.digest === "string" && hashPattern.test(entry.digest)),
  "E_CONFIG", "Invalid resource lock entry; run modeck res init");
  requireValue(new Set(entries.map(entry => entry.target.toLowerCase())).size === entries.length,
    "E_CONFIG", "Duplicate resource lock targets; run modeck res init");
  const target = useResourcePath(id, spec.kind);
  const entry = entries.find(entry => entry.target === target);
  requireValue(entry && entry.url === spec.source.url && entry.path === spec.source.path
    && (entry.kind ?? "skill") === spec.kind && (entry.id === undefined || entry.id === id),
  "E_RESOURCE_MISSING", "Installed resource does not match its declaration; run modeck res init", { id });
  const snapshot = await localSnapshot(context, id, spec);
  requireValue(snapshot.treeDigest === entry!.digest, "E_INTEGRITY", "Installed resource differs from its lock", { id });
  return { snapshot, commit: entry!.commit };
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

const cachedGit = async (request: ReadResourcesRequest, stateRoot: string, id: string, spec: ResourceSpec): Promise<ManifestResource | null> => {
  const path = cachePath(request.context, stateRoot, id, spec);
  if (!await exists(path)) return null;
  const { bytes } = await regularBytes(path, LIMITS.manifestBytes);
  const manifest = request.parseManifest(parseJson(utf8(bytes)));
  const resource = manifest.resources[0];
  requireValue(manifest.resources.length === 1 && resource?.id === id && resource.kind === spec.kind
    && resource.sourceDigest === digest(spec) && resource.commit !== null
    && manifest.resourceSpecDigest === digest({ [id]: spec }), "E_INTEGRITY", "Git cache does not match its resource", { id });
  return resource!;
};

const cacheGit = async (context: ConfigContext, stateRoot: string, id: string, spec: ResourceSpec, manifestResource: ManifestResource): Promise<void> => {
  const directory = await ensureDirectory(join(stateRoot, "git"));
  const temporary = join(directory, `.stage-${randomUUID()}`);
  const manifest: ResourceManifest = { schemaVersion: 1, resourceSpecDigest: digest({ [id]: spec }), resources: [manifestResource] };
  const bytes = Buffer.from(`${canonical(manifest)}\n`);
  requireValue(bytes.length <= LIMITS.manifestBytes, "E_LIMIT", "Git cache manifest exceeds byte limit");
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await safePath(directory);
    await rename(temporary, cachePath(context, stateRoot, id, spec));
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
};

type ResourceImage = { readonly manifestResource: ManifestResource; readonly verified: VerifiedResource };
const resourceImage = async (request: ReadResourcesRequest, stateRoot: string, id: string, spec: ResourceSpec,
  sync: "reuse" | "update" | null): Promise<ResourceImage> => {
  if (spec.source.type === "git" && sync !== "update") {
    const cached = await cachedGit(request, stateRoot, id, spec);
    if (cached) return { manifestResource: cached, verified: await readObject(stateRoot, cached) };
    requireValue(sync !== null, "E_RESOURCE_MISSING", "Git resource is not cached; run modeck sync", { id });
  }
  const fetched = spec.source.type === "git" ? await gitSnapshot(request.context, stateRoot, spec)
    : spec.source.type === "use" ? await installedSnapshot(request.context, id, spec)
      : { snapshot: await localSnapshot(request.context, id, spec), commit: null };
  resourceEntry(fetched.snapshot, spec.kind);
  const manifestResource: ManifestResource = { id, kind: spec.kind, sourceDigest: digest(spec), commit: fetched.commit,
    treeDigest: fetched.snapshot.treeDigest, entries: fetched.snapshot.entries };
  const verified = await publishObject(stateRoot, manifestResource, fetched.snapshot);
  if (spec.source.type === "git") await cacheGit(request.context, stateRoot, id, spec, manifestResource);
  return { manifestResource, verified };
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
    // Describe verified bytes without writing version metadata into the configuration.
    const manifest = request.parseManifest({ schemaVersion: 1, resourceSpecDigest: digest(context.config.resources),
      resources: images.map(image => image.manifestResource) });
    requireValue(Buffer.byteLength(canonical(manifest)) <= LIMITS.manifestBytes, "E_LIMIT", "Resource manifest exceeds byte limit");
    await validateContext(context, stateRoot);
    return Object.freeze({ schemaVersion: 1 as const, configDigest: context.configDigest,
      manifest, resourceDigest: digest(manifest), resources: Object.freeze(resources) });
  } catch (error) {
    if (error instanceof Error && "code" in error && String(error.code).startsWith("E_")) throw error;
    throw modeError("E_IO", "Resource operation failed", { cause: String(error) });
  }
};

export const readResources = async (request: ReadResourcesRequest): Promise<VerifiedResourceSet> => resourcesFor(request, null);

export const syncResources = async (request: SyncResourcesRequest): Promise<VerifiedResourceSet> => {
  requireValue(request.mode === "reuse" || request.mode === "update", "E_USAGE",
    "Unsupported resource synchronization mode");
  return resourcesFor(request, request.mode === "update" ? "update" : "reuse");
};
