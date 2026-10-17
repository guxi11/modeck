import { constants } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, modeError, sha256 } from "../contracts/index.js";
import type { FileImage } from "../contracts/index.js";
import type { StaticMcpRequest } from "../contracts/mcp-static.js";
import { checkDirectory, data, ensureParents, imageJson, jsonImage, missing, object, parentIdentity, readImage, safeAbsolute, same } from "../integration/fs.js";
import { withMcpMutex } from "./mutex.js";

export type Change = Readonly<{ path: string; before: FileImage | null; after: FileImage | null }>;
type TransactionContext = Readonly<Pick<StaticMcpRequest, "agent" | "scope" | "cwd" | "targetHome"> & {
  stateRoot: string; journalPath: string; stateDev: number; stateIno: number;
}>;
type Journal = TransactionContext & Readonly<{ schemaVersion: 1; owner: "modeck/static-mcp/1"; target: string; central: string;
  phase: "pending" | "committed"; changes: readonly Change[] }>;
type HeldLock = Readonly<{ path: string; dev: number; ino: number; token: string }>;
type Stage = Readonly<{ path: string; dev: number; ino: number; parentDev: number; parentIno: number }>;
type Staging = { files: readonly Stage[]; next: number };
const owner = "modeck/static-mcp/1" as const;
const hash = (value: string): string => sha256(Buffer.from(value));
export const stateDirectory = (home: string): string => join(home, ".local/share/modeck/static-mcp");
export const ownershipPath = (home: string, target: string): string => join(stateDirectory(home), `${hash(target)}.json`);
const journalPath = (home: string, target: string): string => join(stateDirectory(home), `${hash(target)}.journal.json`);
const transactionContext = async (request: StaticMcpRequest, target: string): Promise<TransactionContext> => {
  const journal = journalPath(request.targetHome, target);
  const parent = await parentIdentity(journal);
  return { agent: request.agent, scope: request.scope, cwd: request.cwd, targetHome: request.targetHome,
    stateRoot: stateDirectory(request.targetHome), journalPath: journal, stateDev: parent.dev, stateIno: parent.ino };
};
const assertContext = async (value: Readonly<Record<string, unknown>>, request: StaticMcpRequest, target: string): Promise<void> => {
  const expected = await transactionContext(request, target);
  if (Object.entries(expected).some(([key, item]) => value[key] !== item)) {
    throw modeError("E_INSTALL_CONFLICT", "MCP recovery home/state/scope identity does not match the original transaction; use its original agent, scope, target-home, cwd and config. Original locks were not cleared");
  }
};
const lockPaths = (central: string, target: string): readonly string[] => [...new Set([central, target])].sort().map(path => `${path}.modeck-mcp.lock`);
const inside = (parent: string, child: string): boolean => { const path = relative(parent, child); return path === "" || path !== ".." && !path.startsWith("../") && !path.startsWith("/"); };
const privateFile = async (path: string, singleLink = true): Promise<void> => {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || singleLink && stat.nlink !== 1) {
    throw modeError("E_INSTALL_CONFLICT", "MCP recovery metadata must be a private, singly linked file owned by this user");
  }
};
const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
};
const durableParents = async (anchor: string, path: string): Promise<void> => {
  const created = await ensureParents(anchor, path);
  for (const directory of [...created].reverse()) {
    await syncDirectory(directory); await syncDirectory(dirname(directory));
  }
};
const ensureState = async (request: StaticMcpRequest, target: string): Promise<void> => {
  const directory = stateDirectory(request.targetHome);
  // Reject before mkdir: even an uninitialized project must not acquire a Git-visible secret cache.
  if (inside(request.configRoot, directory) || inside(request.cwd, directory)) {
    throw modeError("E_CONFIG", "MCP private recovery state would be inside the configuration or target project directory; choose separate configuration and project paths");
  }
  for (let ancestor = directory; ; ancestor = dirname(ancestor)) {
    const git = await lstat(join(ancestor, ".git")).catch(error => { if (missing(error)) return null; throw error; });
    if (git) throw modeError("E_CONFIG", "MCP private recovery state would be inside a Git working tree; choose a target home outside the repository");
    if (dirname(ancestor) === ancestor) break;
  }
  await durableParents(request.targetHome, join(directory, "placeholder"));
  await checkDirectory(directory);
  const stat = await lstat(directory);
  if ((stat.mode & 0o777) !== 0o700) throw modeError("E_INSTALL_CONFLICT", "MCP private state directory must have mode 0700");
};
const cleanupStages = async (stages: readonly Stage[]): Promise<void> => {
  for (const stage of stages) {
    await safeAbsolute(stage.path);
    const parent = await parentIdentity(stage.path);
    if (parent.dev !== stage.parentDev || parent.ino !== stage.parentIno) throw modeError("E_INSTALL_CONFLICT", "MCP private staging directory changed; refusing cleanup");
    const current = await lstat(stage.path).catch(error => { if (missing(error)) return null; throw error; });
    if (!current) continue;
    if (!current.isFile() || current.dev !== stage.dev || current.ino !== stage.ino || current.nlink !== 1
      || current.uid !== process.getuid?.()) throw modeError("E_INSTALL_CONFLICT", "MCP staging ownership changed; no foreign file was removed");
    await unlink(stage.path); await syncDirectory(dirname(stage.path));
  }
};
const createStages = async (request: StaticMcpRequest, count: number): Promise<Staging> => {
  const directory = stateDirectory(request.targetHome);
  const files: Stage[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const path = join(directory, `.modeck-mcp-stage-${randomUUID()}`);
      const parent = await parentIdentity(path);
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = await handle.stat();
        files.push({ path, dev: stat.dev, ino: stat.ino, parentDev: parent.dev, parentIno: parent.ino });
        await handle.sync();
      } finally { await handle.close(); }
    }
    await syncDirectory(directory);
    return { files, next: 0 };
  } catch (error) { await cleanupStages(files); throw error; }
};
const checkedStages = (value: unknown, home: string): readonly Stage[] => {
  if (value === undefined) return []; // Locks from an interrupted earlier implementation have no stage inventory.
  if (!Array.isArray(value) || value.length > 8) throw modeError("E_INSTALL_CONFLICT", "Invalid MCP private staging inventory");
  const stages = value.map(raw => {
    const stage = object(raw);
    if (Object.keys(stage).length !== 5 || typeof stage.path !== "string"
      || dirname(stage.path) !== stateDirectory(home)
      || !/^\.modeck-mcp-stage-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(stage.path.slice(dirname(stage.path).length + 1))
      || [stage.dev, stage.ino, stage.parentDev, stage.parentIno].some(item => !Number.isSafeInteger(item) || (item as number) < 0)) {
      throw modeError("E_INSTALL_CONFLICT", "MCP staging inventory does not identify this private state directory");
    }
    return stage as Stage;
  });
  if (new Set(stages.map(stage => stage.path)).size !== stages.length) throw modeError("E_INSTALL_CONFLICT", "Duplicate MCP private staging identity");
  return stages;
};
// Existing filesystem helpers enforce symlink and parent identity checks; this variant also fsyncs
// the write-ahead journal, replacement file and directory before acknowledging each write.
const durableReplace = async (change: Change, staging: Staging): Promise<void> => {
  const expectedParent = await parentIdentity(change.path);
  const currentImage = (): Promise<FileImage | null> => readImage(change.path, 70_000_000);
  if (!same(await currentImage(), change.before)) throw modeError("E_PLAN_STALE", "MCP destination changed before writing; no conflicting data was overwritten");
  const checkParent = async (): Promise<void> => {
    if (canonical(await parentIdentity(change.path)) !== canonical(expectedParent)) throw modeError("E_PLAN_STALE", "MCP destination directory changed during writing");
  };
  if (change.after === null) {
    await checkParent();
    if (!same(await currentImage(), change.before)) throw modeError("E_PLAN_STALE", "MCP destination changed before removal");
    if (change.before) await unlink(change.path);
    await syncDirectory(dirname(change.path));
    return;
  }
  const stage = staging.files[staging.next++];
  if (!stage) throw modeError("E_INSTALL_CONFLICT", "MCP private staging inventory was exhausted");
  if (expectedParent.dev !== stage.dev) throw modeError("E_CONFIG", "Atomic MCP writes require private state and destination on the same filesystem; use a target home on that filesystem or user scope");
  const stageParent = await parentIdentity(stage.path);
  if (stageParent.dev !== stage.parentDev || stageParent.ino !== stage.parentIno) throw modeError("E_PLAN_STALE", "MCP private staging directory changed");
  const temporary = stage.path;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const identity = await handle.stat();
    if (!identity.isFile() || identity.dev !== stage.dev || identity.ino !== stage.ino || identity.nlink !== 1
      || identity.uid !== process.getuid?.() || identity.size !== 0) throw modeError("E_INSTALL_CONFLICT", "MCP staging file changed before use");
    await handle.writeFile(data(change.after));
    await handle.chmod(change.after.mode);
    await handle.sync(); await handle.close();
    await checkParent();
    if (canonical(await parentIdentity(temporary)) !== canonical(stageParent)) throw modeError("E_PLAN_STALE", "MCP private staging directory changed before rename");
    const currentStage = await lstat(temporary);
    if (currentStage.dev !== stage.dev || currentStage.ino !== stage.ino || currentStage.nlink !== 1) throw modeError("E_PLAN_STALE", "MCP staging file changed before rename");
    if (!same(await readImage(temporary, 70_000_000), change.after)) throw modeError("E_PLAN_STALE", "MCP staging content changed before rename");
    if (!same(await currentImage(), change.before)) throw modeError("E_PLAN_STALE", "MCP destination changed during writing; conflicting data preserved");
    await rename(temporary, change.path);
    await syncDirectory(dirname(change.path));
    if (dirname(change.path) !== dirname(temporary)) await syncDirectory(dirname(temporary));
  } catch (error) {
    await handle.close().catch(() => undefined);
    await (async () => {
      await cleanupStages([stage]);
    })().catch(() => undefined);
    throw error;
  }
};
const release = async (lock: HeldLock): Promise<void> => {
  const current = await lstat(lock.path);
  if (current.dev !== lock.dev || current.ino !== lock.ino) throw modeError("E_INSTALL_CONFLICT", "MCP lock ownership changed; recovery metadata retained");
  await unlink(lock.path); await syncDirectory(dirname(lock.path));
};
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
};
const staleLock = async (path: string, central: string, target: string, request: StaticMcpRequest): Promise<void> => {
  const image = await readImage(path);
  if (!image) return;
  await privateFile(path, false);
  const identity = await lstat(path);
  const value = object(imageJson(image));
  if (value.owner !== owner || value.central !== central || value.target !== target || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0 || typeof value.token !== "string") throw modeError("E_INSTALL_CONFLICT", "MCP lock belongs to another transaction; recover it using its original target and configuration");
  // A shared project target does not identify HOME: validate its journal/state owner before any cleanup.
  await assertContext(value, request, target);
  if (alive(value.pid as number)) throw modeError("E_BUSY", "Another MCP process still owns this lock; wait for it to finish");
  if (identity.nlink !== 1) {
    // A crash between link() and unlink(temp) leaves exactly these two links to the fully written lock.
    if (identity.nlink !== 2 || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.token)) {
      throw modeError("E_INSTALL_CONFLICT", "MCP stale lock has unrecognized hard links; inspect them before recovery");
    }
    const temporary = join(dirname(path), `.modeck-mcp-lock-${value.token}`);
    await safeAbsolute(temporary);
    const alias = await lstat(temporary).catch(error => { if (missing(error)) return null; throw error; });
    if (!alias?.isFile() || alias.dev !== identity.dev || alias.ino !== identity.ino || alias.nlink !== 2
      || !same(await readImage(path), image)) throw modeError("E_INSTALL_CONFLICT", "MCP stale lock's temporary alias cannot be identified safely");
    await unlink(temporary); await syncDirectory(dirname(path));
  }
  const current = await lstat(path);
  if (current.dev !== identity.dev || current.ino !== identity.ino || current.nlink !== 1
    || !same(await readImage(path), image)) throw modeError("E_BUSY", "MCP lock changed during recovery");
  await cleanupStages(checkedStages(value.stages, request.targetHome));
  await unlink(path); await syncDirectory(dirname(path));
};
const acquire = async (request: StaticMcpRequest, central: string, target: string, recovery: boolean, staging: Staging): Promise<readonly HeldLock[]> => {
  const held: HeldLock[] = [];
  try {
    const context = await transactionContext(request, target);
    if (staging.files.some(stage => stage.parentDev !== context.stateDev || stage.parentIno !== context.stateIno)) {
      throw modeError("E_PLAN_STALE", "MCP private state identity changed before locking");
    }
    for (const path of lockPaths(central, target)) {
      await durableParents(path === `${central}.modeck-mcp.lock` ? request.configRoot
        : request.scope === "project" ? request.cwd : request.targetHome, path);
      await checkDirectory(dirname(path));
      if (recovery) await staleLock(path, central, target, request);
      const token = randomUUID();
      const temporary = join(dirname(path), `.modeck-mcp-lock-${token}`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        // Persist every staging inode before any native/journal bytes enter it, including journal's first write.
        await handle.writeFile(JSON.stringify({ owner, pid: process.pid, token, target, central, ...context, stages: staging.files })); await handle.sync();
        const stat = await handle.stat();
        // Claim a fully written lock with one atomic hard-link operation; a crash cannot leave an empty lock.
        try { await link(temporary, path); }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "EEXIST") throw modeError("E_BUSY", "MCP transaction lock exists; wait for an active process or run mcp recover with the same target and configuration");
          throw error;
        }
        held.push({ path, token, dev: stat.dev, ino: stat.ino });
      } finally { await handle.close(); await unlink(temporary).catch(() => undefined); }
      await syncDirectory(dirname(path));
    }
    return held;
  } catch (error) {
    for (const lock of held.reverse()) await release(lock).catch(() => undefined);
    throw error;
  }
};
const checkedImage = (value: unknown): FileImage | null => {
  if (value === null) return null;
  const image = object(value);
  if (Object.keys(image).some(key => !["data", "encoding", "mode"].includes(key)) || typeof image.data !== "string"
    || !["utf8", "base64"].includes(String(image.encoding)) || !Number.isInteger(image.mode)
    || (image.mode as number) < 0 || (image.mode as number) > 0o777) throw modeError("E_CONFIG", "Invalid MCP recovery image");
  return image as FileImage;
};
const loadJournal = async (request: StaticMcpRequest, central: string, target: string): Promise<Journal | null> => {
  const path = journalPath(request.targetHome, target);
  const image = await readImage(path, 70_000_000);
  if (!image) return null;
  await privateFile(path);
  const root = object(imageJson(image));
  if (Object.keys(root).some(key => !["schemaVersion", "owner", "target", "central", "phase", "changes", "agent", "scope", "cwd", "targetHome", "stateRoot", "journalPath", "stateDev", "stateIno"].includes(key))
    || root.schemaVersion !== 1 || root.owner !== owner || root.target !== target || root.central !== central
    || !["pending", "committed"].includes(String(root.phase)) || !Array.isArray(root.changes) || root.changes.length > 2) {
    throw modeError("E_INSTALL_CONFLICT", "MCP recovery journal does not match this target and configuration");
  }
  await assertContext(root, request, target);
  const changes = root.changes.map(raw => {
    const change = object(raw);
    if (Object.keys(change).some(key => !["path", "before", "after"].includes(key)) || typeof change.path !== "string"
      || ![central, target, ownershipPath(request.targetHome, target)].includes(change.path)) throw modeError("E_INSTALL_CONFLICT", "Invalid MCP recovery destination");
    return { path: change.path, before: checkedImage(change.before), after: checkedImage(change.after) };
  });
  if (new Set(changes.map(change => change.path)).size !== changes.length) throw modeError("E_CONFIG", "Duplicate MCP recovery destination");
  return { ...await transactionContext(request, target), schemaVersion: 1, owner, target, central, phase: root.phase as Journal["phase"], changes };
};
const removeJournal = async (request: StaticMcpRequest, target: string, staging: Staging): Promise<void> => {
  const path = journalPath(request.targetHome, target);
  const before = await readImage(path, 70_000_000);
  if (before) await durableReplace({ path, before, after: null }, staging);
};
const rollback = async (changes: readonly Change[], staging: Staging): Promise<boolean> => {
  let restored = true;
  for (const change of [...changes].reverse()) {
    try {
      const current = await readImage(change.path);
      if (same(current, change.before)) continue;
      if (!same(current, change.after)) { restored = false; continue; }
      await durableReplace({ path: change.path, before: change.after, after: change.before }, staging);
    } catch { restored = false; }
  }
  for (const change of changes) {
    try { if (!same(await readImage(change.path), change.before)) restored = false; }
    catch { restored = false; }
  }
  return restored;
};
export const assertNoJournal = async (request: StaticMcpRequest, target: string): Promise<void> => {
  if (await readImage(journalPath(request.targetHome, target), 70_000_000)) throw modeError("E_INSTALL_CONFLICT", "An interrupted MCP transaction requires mcp recover with the same target and configuration before proceeding");
};
export const transact = async (request: StaticMcpRequest, central: string, target: string, changes: readonly Change[], verify: (written?: readonly Change[]) => Promise<void>): Promise<void> => withMcpMutex([central, target], async () => {
  if (!changes.length) { await verify(); return; }
  await ensureState(request, target);
  const staging = await createStages(request, changes.length * 2 + 2);
  let held: readonly HeldLock[];
  try { held = await acquire(request, central, target, false, staging); }
  catch (error) { await cleanupStages(staging.files); throw error; }
  let retain = false;
  try {
    await assertNoJournal(request, target);
    await verify();
    for (const change of changes) {
      await durableParents(change.path === central ? request.configRoot
        : change.path === target && request.scope === "project" ? request.cwd : request.targetHome, change.path);
      if ((await parentIdentity(change.path)).dev !== staging.files[0]!.dev) {
        throw modeError("E_CONFIG", "Atomic MCP writes require private state and destination on the same filesystem; use a target home on that filesystem or user scope");
      }
      if (!same(await readImage(change.path), change.before)) throw modeError("E_PLAN_STALE", "MCP configuration changed while acquiring transaction locks");
    }
    const path = journalPath(request.targetHome, target);
    const journal: Journal = { ...await transactionContext(request, target), schemaVersion: 1, owner, target, central, phase: "pending", changes };
    await durableReplace({ path, before: null, after: jsonImage(journal) }, staging);
    try {
      await verify();
      for (const change of changes) await durableReplace(change, staging);
      await verify(changes);
    } catch (error) {
      if (!await rollback(changes, staging)) {
        retain = true;
        throw modeError("E_INSTALL_CONFLICT", "MCP transaction could not be fully rolled back because files changed externally; private journal and locks retained. Run mcp recover after inspecting native files");
      }
      await removeJournal(request, target, staging);
      throw error;
    }
    // Never roll back after the durable commit marker: recovery will finish cleanup instead.
    try {
      await durableReplace({ path, before: await readImage(path, 70_000_000), after: jsonImage({ ...journal, phase: "committed" }) }, staging);
      await removeJournal(request, target, staging);
    } catch {
      retain = true;
      throw modeError("E_INSTALL_CONFLICT", "MCP writes completed but transaction finalization needs mcp recover; private journal and locks retained");
    }
  } catch (error) {
    const remaining = await readImage(journalPath(request.targetHome, target), 70_000_000).catch(() => true);
    if (remaining && !retain) {
      retain = true;
      throw modeError("E_INSTALL_CONFLICT", "MCP transaction finalization was interrupted; private journal and locks retained. Run mcp recover using the original options");
    }
    throw error;
  } finally {
    if (!retain) {
      await cleanupStages(staging.files);
      for (const lock of [...held].reverse()) await release(lock);
    }
  }
});
export const recover = async (request: StaticMcpRequest, central: string, target: string): Promise<string> => withMcpMutex([central, target], async () => {
  await ensureState(request, target);
  // Refuse a mismatched journal before replacing stale locks; re-read under the acquired locks below.
  await loadJournal(request, central, target);
  const staging = await createStages(request, 6);
  let held: readonly HeldLock[];
  try { held = await acquire(request, central, target, true, staging); }
  catch (error) { await cleanupStages(staging.files); throw error; }
  let retain = false;
  try {
    const journal = await loadJournal(request, central, target);
    if (!journal) return "No pending journal; stale transaction locks cleared";
    if (journal.phase === "committed") {
      for (const change of journal.changes) {
        if (!same(await readImage(change.path), change.after)) {
          retain = true;
          throw modeError("E_INSTALL_CONFLICT", "Committed MCP files changed externally; recovery refuses to overwrite them. Private journal retained for inspection");
        }
      }
    } else if (!await rollback(journal.changes, staging)) {
      retain = true;
      throw modeError("E_INSTALL_CONFLICT", "MCP recovery found externally modified files; no conflicting data was overwritten. Private journal retained for inspection");
    }
    await removeJournal(request, target, staging);
    return journal.phase === "committed" ? "Committed transaction cleanup completed" : "Interrupted transaction rolled back safely";
  } finally {
    if (!retain) {
      await cleanupStages(staging.files);
      for (const lock of [...held].reverse()) await release(lock);
    }
  }
});
