import { join } from "node:path";
import { canonical, LIMITS, modeError, parseJson, sha256, useResourcePath } from "../contracts/index.js";
import type {
  ConfigContext, Kind, ManifestResource, ReadResourcesRequest, ResourceManifest, ResourceSpec,
  VerifiedResource, VerifiedResourceSet,
} from "../contracts/index.js";
import { childPath, commitPattern, compare, hashPattern, missing, regularBytes, requireValue, safePath, utf8 } from "./fs.js";
import { validateContext } from "./manifest.js";
import { resourceEntry, validateNames } from "./skill.js";
import { publishObject } from "./store.js";
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

type ResourceImage = { readonly manifestResource: ManifestResource; readonly verified: VerifiedResource };
const resourceImage = async (request: ReadResourcesRequest, stateRoot: string, id: string, spec: ResourceSpec): Promise<ResourceImage> => {
  const fetched = spec.source.type === "use" ? await installedSnapshot(request.context, id, spec)
    : { snapshot: await localSnapshot(request.context, id, spec), commit: null };
  resourceEntry(fetched.snapshot, spec.kind);
  const manifestResource: ManifestResource = { id, kind: spec.kind, sourceDigest: digest(spec), commit: fetched.commit,
    treeDigest: fetched.snapshot.treeDigest, entries: fetched.snapshot.entries };
  const verified = await publishObject(stateRoot, manifestResource, fetched.snapshot);
  return { manifestResource, verified };
};

export const readResources = async (request: ReadResourcesRequest): Promise<VerifiedResourceSet> => {
  try {
    const { context } = request;
    const stateRoot = await safePath(request.stateRoot, true);
    await validateContext(context, stateRoot);
    const ids = [...new Set(request.resourceIds ?? Object.keys(context.config.resources))].sort(compare);
    const images = await ids.reduce(async (pending, id) => {
      const current = await pending;
      const spec = context.config.resources[id];
      requireValue(spec, "E_CONFIG", "Unknown requested resource", { id });
      return [...current, await resourceImage(request, stateRoot, id, spec!)];
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
