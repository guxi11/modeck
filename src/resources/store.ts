import { chmod, lstat, mkdtemp, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonical, LIMITS, modeError, parseJson } from "../contracts/index.js";
import type { LockedResource, VerifiedResource } from "../contracts/index.js";
import { compare, ensureDirectory, exists, hashPattern, missing, regularBytes, removeTemporary, requireValue, safePath, utf8 } from "./fs.js";
import { resourceEntry } from "./skill.js";
import { snapshotLocal, validateEntries, writeSnapshot } from "./tree.js";
import type { Snapshot } from "./tree.js";

export const objectPath = (stateRoot: string, digest: string): string => {
  requireValue(hashPattern.test(digest), "E_LOCK_MISMATCH", "Invalid content tree digest");
  return join(stateRoot, "store", "sha256", digest);
};

export const matchesLock = (snapshot: Snapshot, locked: LockedResource): boolean =>
  snapshot.treeDigest === locked.treeDigest && canonical(snapshot.entries) === canonical(locked.entries);

export const readObject = async (stateRoot: string, locked: LockedResource): Promise<VerifiedResource> => {
  const object = objectPath(stateRoot, locked.treeDigest);
  if (!await exists(object)) throw modeError("E_RESOURCE_MISSING", "Locked content is missing; run sync", { id: locked.id, path: object });
  try {
    await safePath(object);
    requireValue((await lstat(object)).isDirectory(), "E_INTEGRITY", "Content object is not a directory");
    const names = (await readdir(object)).sort(compare);
    requireValue(canonical(names) === canonical(["manifest.json", "tree"]), "E_INTEGRITY", "Unexpected content object entries", { id: locked.id });
    const { bytes } = await regularBytes(join(object, "manifest.json"), LIMITS.lockBytes);
    const text = utf8(bytes);
    const manifest = parseJson(text);
    validateEntries(locked.entries);
    requireValue(canonical(manifest) === canonical(locked.entries) && text === `${canonical(locked.entries)}\n`,
      "E_INTEGRITY", "Stored tree manifest differs from the lock", { id: locked.id });
    const root = join(object, "tree");
    // Scan the entire directory even for a rule, so added siblings cannot hide.
    const snapshot = await snapshotLocal(root, "skill");
    requireValue(matchesLock(snapshot, locked), "E_INTEGRITY", "Stored resource content differs from the lock", { id: locked.id });
    return { id: locked.id, kind: locked.kind, treeDigest: locked.treeDigest, root,
      entry: join(root, locked.kind === "rule" ? "content.md" : "SKILL.md"), ...resourceEntry(snapshot, locked.kind) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "E_CONFIG") {
      throw modeError("E_INTEGRITY", "Stored tree manifest is invalid JSON", { id: locked.id });
    }
    if (error instanceof Error && "code" in error && String(error.code).startsWith("E_")) throw error;
    throw modeError("E_INTEGRITY", missing(error) ? "Stored resource is incomplete" : "Cannot verify stored resource", { id: locked.id });
  }
};

export const publishObject = async (stateRoot: string, locked: LockedResource, snapshot: Snapshot): Promise<VerifiedResource> => {
  requireValue(matchesLock(snapshot, locked), "E_INTEGRITY", "Refusing to publish mismatched resource", { id: locked.id });
  resourceEntry(snapshot, locked.kind);
  const target = objectPath(stateRoot, locked.treeDigest);
  if (await exists(target)) return readObject(stateRoot, locked);
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
    return await readObject(stateRoot, locked);
  } finally { await removeTemporary(temporary); }
};
