import { chmod, lstat, mkdtemp, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonical, LIMITS, modeError, parseJson } from "../contracts/index.js";
import type { ManifestResource, VerifiedResource } from "../contracts/index.js";
import { compare, ensureDirectory, exists, hashPattern, missing, regularBytes, removeTemporary, requireValue, safePath, utf8 } from "./fs.js";
import { resourceEntry } from "./skill.js";
import { snapshotLocal, validateEntries, writeSnapshot } from "./tree.js";
import type { Snapshot } from "./tree.js";

export const objectPath = (stateRoot: string, digest: string): string => {
  requireValue(hashPattern.test(digest), "E_MANIFEST_MISMATCH", "Invalid content tree digest");
  return join(stateRoot, "store", "sha256", digest);
};

export const matchesManifest = (snapshot: Snapshot, manifestResource: ManifestResource): boolean =>
  snapshot.treeDigest === manifestResource.treeDigest && canonical(snapshot.entries) === canonical(manifestResource.entries);

const skillRoot = async (stateRoot: string, name: string, snapshot: Snapshot, length = 8): Promise<string> => {
  const base = await ensureDirectory(join(stateRoot, "skills"));
  const prefix = snapshot.treeDigest.slice(0, length);
  const target = join(base, `${name}@${prefix}`);
  if (await exists(target)) {
    const stored = await snapshotLocal(target, "skill");
    if (stored.treeDigest === snapshot.treeDigest) return target;
    // A different complete digest may legitimately share the short prefix.
    requireValue(stored.treeDigest.startsWith(prefix) && resourceEntry(stored, "skill").skill?.name === name,
      "E_INTEGRITY", "Short skill path contains unexpected content", { path: target });
    requireValue(length < snapshot.treeDigest.length, "E_INTEGRITY", "Skill digest collision", { path: target });
    return skillRoot(stateRoot, name, snapshot, length + 1);
  }
  const temporary = await mkdtemp(join(base, ".stage-"));
  try {
    await writeSnapshot(snapshot, temporary, true);
    await safePath(base);
    try { await rename(temporary, target); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && ["EEXIST", "ENOTEMPTY"].includes(String(error.code)))) throw error;
    }
    // Recheck the winner when another process publishes the same short path.
    return await skillRoot(stateRoot, name, snapshot, length);
  } finally { await removeTemporary(temporary); }
};

export const readObject = async (stateRoot: string, manifestResource: ManifestResource): Promise<VerifiedResource> => {
  const object = objectPath(stateRoot, manifestResource.treeDigest);
  if (!await exists(object)) throw modeError("E_RESOURCE_MISSING", "Stored content is missing; run sync", { id: manifestResource.id, path: object });
  try {
    await safePath(object);
    requireValue((await lstat(object)).isDirectory(), "E_INTEGRITY", "Content object is not a directory");
    const names = (await readdir(object)).sort(compare);
    requireValue(canonical(names) === canonical(["manifest.json", "tree"]), "E_INTEGRITY", "Unexpected content object entries", { id: manifestResource.id });
    const { bytes } = await regularBytes(join(object, "manifest.json"), LIMITS.manifestBytes);
    const text = utf8(bytes);
    const manifest = parseJson(text);
    validateEntries(manifestResource.entries);
    requireValue(canonical(manifest) === canonical(manifestResource.entries) && text === `${canonical(manifestResource.entries)}\n`,
      "E_INTEGRITY", "Stored tree manifest differs from the manifest", { id: manifestResource.id });
    const tree = join(object, "tree");
    // Scan the entire directory even for a rule, so added siblings cannot hide.
    const snapshot = await snapshotLocal(tree, "skill");
    requireValue(matchesManifest(snapshot, manifestResource), "E_INTEGRITY", "Stored resource content differs from the manifest", { id: manifestResource.id });
    const metadata = resourceEntry(snapshot, manifestResource.kind);
    const root = metadata.skill ? await skillRoot(stateRoot, metadata.skill.name, snapshot) : tree;
    return { id: manifestResource.id, kind: manifestResource.kind, treeDigest: manifestResource.treeDigest, root,
      entry: join(root, manifestResource.kind === "rule" ? "content.md" : "SKILL.md"), ...metadata };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "E_CONFIG") {
      throw modeError("E_INTEGRITY", "Stored tree manifest is invalid JSON", { id: manifestResource.id });
    }
    if (error instanceof Error && "code" in error && String(error.code).startsWith("E_")) throw error;
    throw modeError("E_INTEGRITY", missing(error) ? "Stored resource is incomplete" : "Cannot verify stored resource", { id: manifestResource.id });
  }
};

export const publishObject = async (stateRoot: string, manifestResource: ManifestResource, snapshot: Snapshot): Promise<VerifiedResource> => {
  requireValue(matchesManifest(snapshot, manifestResource), "E_INTEGRITY", "Refusing to publish mismatched resource", { id: manifestResource.id });
  resourceEntry(snapshot, manifestResource.kind);
  const target = objectPath(stateRoot, manifestResource.treeDigest);
  if (await exists(target)) return readObject(stateRoot, manifestResource);
  const base = await ensureDirectory(join(stateRoot, "store", "sha256"));
  const temporary = await mkdtemp(join(base, ".stage-"));
  try {
    await writeSnapshot(snapshot, join(temporary, "tree"), true);
    await writeFile(join(temporary, "manifest.json"), `${canonical(snapshot.entries)}\n`, { flag: "wx", mode: 0o444 });
    await chmod(join(temporary, "manifest.json"), 0o444);
    await chmod(temporary, 0o555);
    await safePath(base);
    try { await rename(temporary, target); }
    catch (error) { if (!await exists(target)) throw error; }
    return await readObject(stateRoot, manifestResource);
  } finally { await removeTemporary(temporary); }
};
