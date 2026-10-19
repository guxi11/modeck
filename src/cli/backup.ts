import { lstat, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { exists, safePath, within } from "../resources/fs.js";
import { snapshotLocal } from "../resources/tree.js";
import { modeError } from "../contracts/index.js";
import type { Kind } from "../contracts/index.js";
import { checkDirectory } from "../integration/fs.js";
import { scanCatalogReferences } from "../resources/scan.js";
import type { CatalogReferenceScan, ScanResult } from "../resources/scan.js";

export type Backup = { readonly source: string; readonly backup: string; readonly coveredBy?: string };
export type BackupPlan = { readonly entries: readonly { readonly source: string; readonly digest: string; readonly kind?: Kind }[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[] };

export const planBackups = async (scan: ScanResult, ids: readonly string[], configRoot: string, includeRules = false, catalogReferences?: CatalogReferenceScan): Promise<BackupPlan> => {
  const protectedRoots = [configRoot, join(scan.home, ".modeck")];
  const selected = scan.resources.filter(item => (includeRules || item.kind === "skill") && ids.includes(item.id));
  const initialPlan = await selected.reduce(async (pending, resource) => {
    const current = await pending;
    return resource.aliases.reduce(async (previous, path) => {
      const state = await previous;
      if (state.entries.some(item => item.source === path) || state.skipped.some(item => item.path === path)) return state;
      const source = await realpath(path);
      const protectedSource = protectedRoots.some(root => within(root, source));
      const safeParent = await checkDirectory(dirname(path)).then(() => true, () => false);
      const info = await lstat(path);
      const owned = info.uid === process.getuid?.() && !info.isSymbolicLink() && source === path;
      const reason = protectedSource ? "Managed configuration source; retained"
        : !safeParent || !owned ? "Entry is externally owned or beneath a symbolic-link catalog; retained" : null;
      return reason ? { ...state, skipped: [...state.skipped, { path, reason }] }
        : { ...state, entries: [...state.entries, { source: path, digest: resource.treeDigest, kind: resource.kind }] };
    }, Promise.resolve(current));
  }, Promise.resolve({ entries: [], skipped: [] } as BackupPlan));
  const preserved = await Promise.all([...new Set([
    ...initialPlan.skipped.map(item => item.path),
    ...scan.resources.filter(resource => !selected.includes(resource)).flatMap(resource => resource.aliases),
  ])].map(async path => ({ path, source: await realpath(path) })));
  const referenceScan = catalogReferences ?? await scanCatalogReferences(scan.home);
  const references = [...preserved, ...referenceScan.references
    .flatMap(reference => reference.source === null ? [] : [{ path: reference.path, source: reference.source }])];
  // An unreadable catalog may hold links into any entry, so nothing can be proven unshared.
  const unverified = referenceScan.excluded[0];
  const shared = initialPlan.entries.flatMap(entry => {
    const reference = unverified ? { path: `${unverified.path} (unreadable; references unverified)` }
      : references.find(reference => within(entry.source, reference.source) || within(reference.source, entry.source));
    return reference ? [{ entry, reference }] : [];
  });
  const plan: BackupPlan = {
    entries: initialPlan.entries.filter(entry => !shared.some(item => item.entry === entry)),
    skipped: [...initialPlan.skipped, ...shared.map(({ entry, reference }) => ({
      path: entry.source, reason: `Shared source referenced by retained entry ${reference.path}; retained to keep that reference intact`,
    }))],
  };
  plan.entries.forEach(entry => {
    const omitted = scan.resources.filter(resource => resource.kind === "skill" && !ids.includes(resource.id))
      .flatMap(resource => resource.aliases).filter(path => path !== entry.source && within(entry.source, path));
    const retained = plan.skipped.filter(item => item.path !== entry.source && within(entry.source, item.path));
    if (omitted.length || retained.length) throw modeError("E_USAGE", "Cannot back up a parent skill while descendant skills are unselected or retained; include every descendant or migrate only child skills", {
      parent: entry.source, descendants: [...omitted, ...retained.map(item => item.path)],
    });
  });
  return plan;
};

export const restoreBackups = async (entries: readonly Backup[]): Promise<void> => {
  await entries.filter(entry => !entries.some(parent => parent.source !== entry.source && within(parent.source, entry.source))).reverse().reduce(async (pending, entry) => {
    await pending;
    if (await exists(entry.source)) throw modeError("E_PATH", "Cannot restore backup over an existing entry", entry);
    await safePath(dirname(entry.source));
    await rename(entry.backup, entry.source);
  }, Promise.resolve());
};

export const backupSkills = async (configRoot: string, plan: BackupPlan, checkExternal: () => void | Promise<void> = () => undefined): Promise<{ readonly directory: string | null; readonly entries: readonly Backup[] }> => {
  if (!plan.entries.length) return { directory: null, entries: [] };
  const directory = join(configRoot, ".modeck", "backups", `${Date.now()}-${randomUUID()}`);
  await safePath(directory, true);
  await checkDirectory(configRoot);
  await checkDirectory(join(configRoot, ".modeck"));
  await checkDirectory(join(configRoot, ".modeck", "backups"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ignore = join(configRoot, ".modeck", ".gitignore");
  if (!await exists(ignore)) await writeFile(ignore, "*\n", { flag: "wx", mode: 0o600 });
  const moved: Backup[] = [];
  await Promise.all(plan.entries.map(entry => checkDirectory(dirname(entry.source))));
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  const check = async () => {
    await checkExternal();
    if (interrupted) throw modeError("E_USAGE", "Skill backup interrupted; restoring native entries");
  };
  process.on("SIGINT", interrupt);
  try {
    await check();
    // Record every intended restore path before the first native entry is moved.
    const entries: readonly Backup[] = plan.entries.map(item => {
      const parent = plan.entries.filter(other => other.source !== item.source && within(other.source, item.source))
        .sort((a, b) => a.source.length - b.source.length)[0];
      return { source: item.source, backup: join(directory, "entries", relative("/", item.source)), ...(parent ? { coveredBy: parent.source } : {}) };
    });
    await writeFile(join(directory, "restore.json"), `${JSON.stringify({ entries }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const checked = await Promise.all(entries.map(async (entry, index) => {
      await safePath(dirname(entry.source));
      const info = await lstat(entry.source);
      const snapshot = await snapshotLocal(await realpath(entry.source), plan.entries[index]!.kind ?? "skill");
      if (snapshot.treeDigest !== plan.entries[index]!.digest) throw modeError("E_INTEGRITY", "Skill changed before backup", { path: entry.source });
      return { entry, info, kind: plan.entries[index]!.kind ?? "skill", digest: plan.entries[index]!.digest };
    }));
    await checked.filter(item => !item.entry.coveredBy).reduce(async (pending, { entry, info, kind, digest }) => {
      await pending; await check();
      await checkDirectory(dirname(entry.source));
      await mkdir(dirname(entry.backup), { recursive: true, mode: 0o700 });
      const current = await lstat(entry.source);
      if (current.ino !== info.ino || current.dev !== info.dev) throw modeError("E_INTEGRITY", "Skill entry changed before backup", { path: entry.source });
      if ((await snapshotLocal(await realpath(entry.source), kind)).treeDigest !== digest) {
        throw modeError("E_INTEGRITY", "Resource content changed before backup", { path: entry.source });
      }
      await check();
      await rename(entry.source, entry.backup);
      moved.push(entry);
      if ((await snapshotLocal(entry.backup, kind)).treeDigest !== digest) {
        throw modeError("E_INTEGRITY", "Resource changed during backup", { path: entry.source });
      }
      await check();
    }, Promise.resolve());
    await check();
    return { directory, entries };
  } catch (error) {
    try { await restoreBackups(moved); }
    catch (restore) { throw modeError("E_IO", "Backup failed and some entries require restoration from restore.json", { directory, cause: String(error), restore: String(restore) }); }
    throw error;
  } finally { process.off("SIGINT", interrupt); }
};
