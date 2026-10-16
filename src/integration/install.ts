import { lstat, open, readdir, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { realpath } from "node:fs/promises";
import { canonical, checkRelativePath, LIMITS, modeError, sha256 } from "../contracts/index.js";
import type { Agent, ApplyBindPlanRequest, Diagnostic, FileChange, FileImage, BindPlan, BindRecord,
  ManagedFile, PlanBindRequest, PlanUnbindRequest } from "../contracts/index.js";
import { atomic, checkDirectory, data, digest, ensureParents, homePath, imageJson, jsonImage, missing,
  object, parentIdentity, readImage, safeAbsolute, same, treeFiles } from "./fs.js";
import type { ParentIdentity } from "./fs.js";
import { hookGroup } from "./hooks.js";
import { prepare } from "./prepare.js";

const owner = "modup/v1" as const;
const locations = (agent: Agent) => ({
  hook: agent === "codex" ? ".codex/hooks.json" : `.${agent}/settings.json`,
  private: `.modup/${agent}`,
  record: `.modup/${agent}/install.json`, lock: `.modup/${agent}/install.lock`,
});
const diagnostic = (code: string, message: string, path: string | null = null): Diagnostic => ({ code, message, path });
const conflict = (message: string, path?: string): never => { throw modeError("E_INSTALL_CONFLICT", message, path ? { path } : {}); };
const allowedOwned = (agent: Agent, path: string): boolean => {
  checkRelativePath(path, false);
  const loc = locations(agent);
  return path.startsWith(`${loc.private}/runtime/`);
};
const hashPlan = (plan: Omit<BindPlan, "planDigest">): BindPlan => ({ ...plan, planDigest: sha256(Buffer.from(canonical(plan))) });
const checkTarget = async (home: string, path: string): Promise<void> => {
  const parents = async (directory: string): Promise<void> => {
    await checkDirectory(directory);
    if (directory !== home) await parents(dirname(directory));
  };
  await parents(dirname(path));
  try {
    const stat = await lstat(path);
    if (stat.uid !== process.getuid?.() || stat.mode & 0o022) conflict("Destination is owned or writable by another user", path);
  } catch (error) { if (!missing(error)) throw error; }
};
const changesFor = async (home: string, paths: readonly { readonly path: string; readonly category: FileChange["category"]; readonly after: FileImage | null }[]): Promise<readonly FileChange[]> =>
  (await Promise.all(paths.map(async change => {
    await checkTarget(home, homePath(home, change.path));
    const before = await readImage(homePath(home, change.path));
    return same(before, change.after) ? null : { ...change, beforeDigest: before ? digest(before) : null, beforeMode: before?.mode ?? null };
  }))).filter((value): value is FileChange => value !== null).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

const shared = (image: FileImage | null): { readonly root: Record<string, unknown>; readonly groups: readonly unknown[] } => {
  const root = image ? object(imageJson(image)) : {};
  const hooks = root.hooks === undefined ? {} : object(root.hooks);
  const groups = hooks.SessionStart ?? [];
  if (!Array.isArray(groups) || groups.some(group => {
    const record = object(group);
    return record.matcher !== undefined && typeof record.matcher !== "string" || !Array.isArray(record.hooks)
      || record.hooks.some(handler => {
        const entry = object(handler);
        return typeof entry.type !== "string" || entry.type === "command" && typeof entry.command !== "string";
      });
  })) return conflict("Invalid SessionStart settings");
  return { root, groups };
};
const replaceGroups = (root: Record<string, unknown>, groups: readonly unknown[], beforeRoot?: Record<string, unknown>): Record<string, unknown> => {
  const hooks = root.hooks === undefined ? {} : object(root.hooks);
  const priorHooks = beforeRoot?.hooks === undefined ? {} : object(beforeRoot.hooks);
  const nextHooks = groups.length || Object.hasOwn(priorHooks, "SessionStart")
    ? { ...hooks, SessionStart: groups } : Object.fromEntries(Object.entries(hooks).filter(([key]) => key !== "SessionStart"));
  if (!Object.keys(nextHooks).length && !beforeRoot?.hooks) return Object.fromEntries(Object.entries(root).filter(([key]) => key !== "hooks"));
  return { ...root, hooks: nextHooks };
};

const lockCheck = async (home: string, agent: Agent): Promise<void> => {
  const path = homePath(home, locations(agent).lock);
  const image = await readImage(path, LIMITS.manifestBytes);
  if (!image) return;
  if (image.mode !== 0o600) return conflict("Unsafe installation lock permissions", path);
  const lock = object(imageJson(image));
  if (lock.schemaVersion === 1 && typeof lock.pid === "number" && Number.isSafeInteger(lock.pid) && lock.pid > 0 && lock.owner === owner) {
    try { process.kill(lock.pid, 0); throw modeError("E_BUSY", "Installation is in progress", { path }); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "E_BUSY") throw error; }
  }
  return conflict("Interrupted installation requires inspection; automatic crash recovery is unsupported", path);
};

const loadRecord = async (home: string, agent: Agent): Promise<BindRecord | null> => {
  const loc = locations(agent);
  await checkTarget(home, homePath(home, loc.record));
  const image = await readImage(homePath(home, loc.record), LIMITS.manifestBytes);
  if (!image) return null;
  if (image.mode !== 0o600) return conflict("Unsafe manifest permissions");
  const value = object(imageJson(image));
  const fields = ["schemaVersion", "owner", "agent", "configRoot", "stateRoot", "runtimeDigest", "files", "hookFile", "hookGroup", "beforeHookFile", "afterHookFileDigest"];
  if (Object.keys(value).some(key => !fields.includes(key)) || value.schemaVersion !== 1 || value.owner !== owner
    || value.agent !== agent || value.hookFile !== loc.hook || !Array.isArray(value.files)
    || typeof value.configRoot !== "string" || !value.configRoot.startsWith("/")
    || typeof value.stateRoot !== "string" || !value.stateRoot.startsWith("/")
    || typeof value.runtimeDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.runtimeDigest)
    || typeof value.afterHookFileDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.afterHookFileDigest)) return conflict("Invalid ownership manifest");
  const files = value.files.map(item => {
    const file = object(item);
    if (Object.keys(file).some(key => !["path", "digest", "mode"].includes(key)) || typeof file.path !== "string"
      || !allowedOwned(agent, file.path) || typeof file.digest !== "string" || !/^[0-9a-f]{64}$/.test(file.digest)
      || typeof file.mode !== "number" || !Number.isInteger(file.mode) || ![0o644, 0o755].includes(file.mode)) return conflict("Invalid owned file");
    return file as unknown as ManagedFile;
  });
  if (new Set(files.map(file => file.path)).size !== files.length) return conflict("Duplicate owned path");
  const group = object(value.hookGroup);
  if (!Array.isArray(group.hooks) || group.hooks.length !== 1 || typeof object(group.hooks[0]).command !== "string") return conflict("Invalid owned hook group");
  const runtime = `${loc.private}/runtime/${value.runtimeDigest}`;
  const cli = `${runtime}/dist/bin/modup.mjs`;
  if (!files.some(file => file.path === cli) || files.some(file => !file.path.startsWith(`${runtime}/`))) {
    return conflict("Manifest runtime identity does not match owned files");
  }
  const command = object(group.hooks[0]).command as string;
  const suffix = hookGroup(agent, homePath(home, cli), value.configRoot, value.stateRoot, "").hooks[0]!.command.slice(2);
  if (!command.endsWith(suffix)) return conflict("Manifest hook does not match its configuration and runtime");
  const executable = command.slice(0, -suffix.length);
  const node = executable.slice(1, -1).replaceAll("'\\''", "'");
  // Validate the recorded absolute executable, without requiring an old Node installation to remain present.
  if (!isAbsolute(node) || /\p{Cc}/u.test(node)
    || canonical(group) !== canonical(hookGroup(agent, homePath(home, cli), value.configRoot, value.stateRoot, node))) {
    return conflict("Manifest hook identity is invalid");
  }
  if (value.beforeHookFile !== null) {
    const before = object(value.beforeHookFile);
    if (typeof before.data !== "string" || !["utf8", "base64"].includes(String(before.encoding))
      || typeof before.mode !== "number" || !Number.isInteger(before.mode) || before.mode < 0 || before.mode > 0o777) return conflict("Invalid saved shared configuration");
    shared(before as unknown as FileImage);
  }
  return { ...value, files } as unknown as BindRecord;
};

const verifyOwned = async (home: string, agent: Agent, record: BindRecord | null, groups: readonly unknown[]): Promise<void> => {
  const loc = locations(agent);
  if (!record) {
    const occupied = await Promise.all([`${loc.private}/runtime`].map(async path => {
      try { await lstat(homePath(home, path)); return path; }
      catch (error) { if (missing(error)) return null; throw error; }
    }));
    const existing = occupied.find(path => path !== null);
    if (existing) return conflict("Unrecorded modup destination already exists", existing);
    if (canonical(groups).includes(join(home, loc.private, "runtime"))) return conflict("Unrecorded modup hook already exists");
    return;
  }
  const files = (await treeFiles(home, `${loc.private}/runtime`)).map(path => `${loc.private}/runtime/${path}`);
  const expected = record.files.map(file => file.path).sort();
  if (canonical(files.sort()) !== canonical(expected)) return conflict("Owned file set has changed");
  await Promise.all(record.files.map(async file => {
    const current = await readImage(homePath(home, file.path));
    if (!current || digest(current) !== file.digest || current.mode !== file.mode) return conflict("Owned file changed or disappeared", file.path);
  }));
  if (groups.filter(group => canonical(group) === canonical(record.hookGroup)).length !== 1) return conflict("Owned hook group changed or disappeared");
};

const basePlan = async (agent: Agent, targetHome: string, operation: BindPlan["operation"], build:
  (home: string, image: FileImage | null, record: BindRecord | null) => Promise<readonly FileChange[]>): Promise<BindPlan> => {
  if (process.platform === "win32") throw modeError("E_PLATFORM", "Installation supports macOS/Linux");
  const home = await safeAbsolute(targetHome);
  const inline = agent === "codex" ? await readImage(join(home, ".codex/config.toml"), LIMITS.jsonBytes).catch(() => null) : null;
  const warnings = agent === "codex" ? [diagnostic("CODEX_HOOK_TRUST", "Review and trust the installed definition in Codex /hooks; installation does not grant trust."),
    ...(inline && /\[\[?\s*hooks(?:\s*\.|\s*\])/.test(data(inline).toString("utf8"))
      ? [diagnostic("CODEX_INLINE_HOOKS", "Inline Codex hooks also load; review all sources to avoid duplicated modup hooks.")] : [])]
    : [diagnostic("HOOK_FAILURE_NONBLOCKING", "Claude waits for SessionStart, but hook failures do not guarantee blocking the first request.")];
  try {
    await checkDirectory(home); await lockCheck(home, agent);
    const loc = locations(agent);
    await checkTarget(home, homePath(home, loc.hook));
    const image = await readImage(homePath(home, loc.hook), LIMITS.jsonBytes);
    if (image && data(image).includes(Buffer.from("GENERATED by evoloop"))) return conflict("evoloop owns the destination", loc.hook);
    const record = await loadRecord(home, agent);
    await verifyOwned(home, agent, record, shared(image).groups);
    const changes = await build(home, image, record);
    return hashPlan({ schemaVersion: 1, operation, agent, targetHome: home, owner, changes, conflicts: [], warnings });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "E_BUSY") throw error;
    return hashPlan({ schemaVersion: 1, operation, agent, targetHome: home, owner, changes: [],
      conflicts: [diagnostic("E_INSTALL_CONFLICT", error instanceof Error ? error.message : String(error))], warnings });
  }
};

export const planBind = async ({ agent, targetHome, configRoot, stateRoot, runtimeRoot }: PlanBindRequest): Promise<BindPlan> => {
  await prepare({ agent, configRoot, stateRoot, cwd: await realpath(process.cwd()) });
  return basePlan(agent, targetHome, "bind", async (home, before, previous) => {
    const loc = locations(agent);
    if (previous && (previous.configRoot !== configRoot || previous.stateRoot !== stateRoot)) return conflict("Unbind before changing the configuration binding");
    const packagePaths = ["dist/bin/modup.mjs", "package.json", "schemas/modes.schema.json", "schemas/manifest.schema.json"].sort();
    const packageFiles = await Promise.all(packagePaths.map(async path => {
      const image = await readImage(join(runtimeRoot, path));
      if (!image) return conflict("Required runtime asset is missing", path);
      return { path, image: { ...image, mode: path === "dist/bin/modup.mjs" || image.mode & 0o111 ? 0o755 : 0o644 } };
    }));
    const runtimeDigest = sha256(Buffer.from(canonical(packageFiles.map(file => ({ path: file.path, digest: digest(file.image), mode: file.image.mode })))));
    const runtime = `${loc.private}/runtime/${runtimeDigest}`;
    const owned = packageFiles.map(file => ({ path: `${runtime}/${file.path}`, image: file.image }));
    const group = hookGroup(agent, homePath(home, `${runtime}/dist/bin/modup.mjs`), configRoot, stateRoot);
    const { root, groups } = shared(before);
    if (previous && previous.runtimeDigest === runtimeDigest && canonical(previous.hookGroup) === canonical(group)
      && canonical(previous.files.map(file => file.path).sort()) === canonical(owned.map(file => file.path).sort())) return [];
    const nextGroups = previous ? groups.map(item => canonical(item) === canonical(previous.hookGroup) ? group : item) : [...groups, group];
    const nextRoot = replaceGroups(root, nextGroups);
    const hookImage = before && canonical(nextRoot) === canonical(root) ? before : jsonImage(nextRoot, before?.mode ?? 0o600);
    const beforeHookFile = previous ? before && (digest(before) !== previous.afterHookFileDigest
      || before.mode !== (previous.beforeHookFile?.mode ?? 0o600))
      ? jsonImage(replaceGroups(root, groups.filter(item => canonical(item) !== canonical(previous.hookGroup)),
        previous.beforeHookFile ? shared(previous.beforeHookFile).root : {}), before.mode)
      : previous.beforeHookFile : before;
    const record: BindRecord = { schemaVersion: 1, owner, agent, configRoot, stateRoot, runtimeDigest,
      files: owned.map(file => ({ path: file.path, digest: digest(file.image), mode: file.image.mode })).sort((a, b) => a.path < b.path ? -1 : 1),
      hookFile: loc.hook, hookGroup: group, beforeHookFile,
      afterHookFileDigest: digest(hookImage) };
    const removed = previous?.files.filter(file => !record.files.some(next => next.path === file.path)) ?? [];
    return changesFor(home, [...owned.map(file => ({ path: file.path, category: "owned" as const, after: file.image })),
      ...removed.map(file => ({ path: file.path, category: "owned" as const, after: null })),
      { path: loc.hook, category: "shared-json", after: hookImage }, { path: loc.record, category: "owned", after: jsonImage(record) }]);
  });
};

export const planUnbind = async ({ agent, targetHome }: PlanUnbindRequest): Promise<BindPlan> => basePlan(agent, targetHome, "unbind", async (home, current, record) => {
  if (!record) return [];
  const loc = locations(agent);
  const { root, groups } = shared(current);
  const remaining = groups.filter(group => canonical(group) !== canonical(record.hookGroup));
  const image = current && digest(current) === record.afterHookFileDigest && current.mode === (record.beforeHookFile?.mode ?? 0o600) ? record.beforeHookFile
    : jsonImage(replaceGroups(root, remaining, record.beforeHookFile ? shared(record.beforeHookFile).root : {}), current?.mode ?? 0o600);
  return changesFor(home, [{ path: loc.hook, category: "shared-json", after: image },
    ...record.files.map(file => ({ path: file.path, category: "owned" as const, after: null })),
    { path: loc.record, category: "owned", after: null }]);
});

const removeEmpty = async (home: string, path: string): Promise<void> => {
  if (path === home || !path.startsWith(`${home}/`)) return;
  try { if ((await readdir(path)).length === 0) { await rmdir(path); await removeEmpty(home, dirname(path)); } }
  catch (error) { if (!missing(error) && !(error instanceof Error && "code" in error && error.code === "ENOTEMPTY")) throw error; }
};

export const applyBindPlan = async ({ plan, expectDigest }: ApplyBindPlanRequest): Promise<void> => {
  const { planDigest, ...payload } = plan;
  if (plan.conflicts.length) return conflict("Installation plan contains conflicts");
  if (hashPlan(payload).planDigest !== planDigest || expectDigest !== undefined && expectDigest !== planDigest) throw modeError("E_PLAN_STALE", "Installation plan digest changed");
  if (!plan.changes.length) return;
  const home = await safeAbsolute(plan.targetHome);
  const loc = locations(plan.agent);
  plan.changes.forEach(change => {
    if (change.path !== loc.hook && change.path !== loc.record && !allowedOwned(plan.agent, change.path)) conflict("Plan contains an unowned path", change.path);
    if (change.after && (!Number.isInteger(change.after.mode) || change.after.mode < 0 || change.after.mode > 0o777)) conflict("Plan has invalid file permissions");
  });
  await checkDirectory(home); await lockCheck(home, plan.agent);
  const lockPath = homePath(home, loc.lock);
  const created = await ensureParents(home, lockPath);
  const directories = new Set(created);
  const lockParent = await parentIdentity(lockPath);
  const lock = await open(lockPath, "wx", 0o600).catch(() => { throw modeError("E_BUSY", "Installation lock already exists"); });
  const completed: { readonly path: string; readonly before: FileImage | null; readonly after: FileImage | null; readonly parent: ParentIdentity }[] = [];
  let keepLock = false;
  try {
    await lock.writeFile(JSON.stringify({ schemaVersion: 1, owner, pid: process.pid }));
    await lock.close();
    const before = new Map(await Promise.all(plan.changes.map(async change => {
      const path = homePath(home, change.path);
      await checkTarget(home, path);
      const image = await readImage(path);
      if ((image ? digest(image) : null) !== change.beforeDigest || (image?.mode ?? null) !== change.beforeMode) throw modeError("E_PLAN_STALE", "Destination changed after planning", { path });
      if (change.category === "shared-json" && image && data(image).includes(Buffer.from("GENERATED by evoloop"))) conflict("evoloop owns this file", path);
      return [change.path, image] as const;
    })));
    const priority = (change: FileChange): number => change.path === loc.record ? 2 : change.category === "shared-json" ? plan.operation === "bind" ? 1 : -1 : 0;
    const ordered = [...plan.changes].sort((a, b) => priority(a) - priority(b));
    await ordered.reduce(async (pending, change) => {
      await pending;
      const path = homePath(home, change.path);
      (await ensureParents(home, path)).forEach(directory => directories.add(directory)); await checkDirectory(dirname(path));
      if (!same(await readImage(path), before.get(change.path) ?? null)) throw modeError("E_PLAN_STALE", "Destination changed during apply", { path });
      const parent = await atomic(path, change.after);
      completed.push({ path, before: before.get(change.path) ?? null, after: change.after, parent });
    }, Promise.resolve());
  } catch (error) {
    await lock.close().catch(() => undefined);
    await [...completed].reverse().reduce(async (pending, change) => {
      await pending;
      if (!same(await readImage(change.path), change.after)) { keepLock = true; return; }
      try { await atomic(change.path, change.before, change.parent); } catch { keepLock = true; }
    }, Promise.resolve());
    if (keepLock) throw modeError("E_INSTALL_CONFLICT", "Rollback could not safely restore every file; inspect the retained lock", { path: lockPath });
    throw error;
  } finally {
    if (!keepLock) {
      await atomic(lockPath, null, lockParent);
      await [...directories].sort((a, b) => b.length - a.length).reduce(async (pending, path) => { await pending; await removeEmpty(home, path); }, Promise.resolve());
      await removeEmpty(home, dirname(lockPath));
    }
  }
  await Promise.all(plan.changes.filter(change => change.after === null).map(change => removeEmpty(home, dirname(homePath(home, change.path)))));
  await Promise.all([...created].reverse().map(path => removeEmpty(home, path)));
};
