import { lstat, open, readdir, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { realpath } from "node:fs/promises";
import { agentDefinitions, canonical, checkRelativePath, LIMITS, modeError, sha256 } from "../contracts/index.js";
import type { Agent, ApplyBindPlanRequest, Diagnostic, FileChange, FileImage, BindPlan, BindRecord,
  ManagedFile, PlanBindRequest, PlanUnbindRequest } from "../contracts/index.js";
import { atomic, checkDirectory, data, digest, ensureParents, homePath, imageJson, jsonImage, missing,
  object, parentIdentity, readImage, safeAbsolute, same, treeFiles } from "./fs.js";
import type { ParentIdentity } from "./fs.js";
import { hookGroup } from "./hooks.js";
import { prepare } from "./prepare.js";
import { convertHookGroup } from "./formats.js";
import { codexSnapshotWarning, mcpRecordPath, mcpSelectionDigest, mcpSnapshotWarning, planBindingMcp, verifyBindingMcp, withMcpLock } from "./mcp.js";
import { codebuddyMcpCandidates, mcpLocation } from "./mcp-native.js";
import { copyJson, immutable } from "../core/values.js";

const owner = "modeck/v1" as const;
const locations = (agent: Agent) => ({
  hook: agentDefinitions[agent].hook.file,
  private: `.modeck/${agent}`,
  record: `.modeck/${agent}/install.json`, lock: `.modeck/${agent}/install.lock`,
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

export const loadRecord = async (home: string, agent: Agent): Promise<BindRecord | null> => {
  const loc = locations(agent);
  await checkTarget(home, homePath(home, loc.record));
  const image = await readImage(homePath(home, loc.record), LIMITS.manifestBytes);
  if (!image) return null;
  if (image.mode !== 0o600) return conflict("Unsafe manifest permissions");
  const value = object(imageJson(image));
  const fields = ["schemaVersion", "owner", "agent", "configRoot", "stateRoot", "runtimeDigest", "files", "hookFile", "hookGroup", "beforeHookFile", "afterHookFileDigest", "mcp"];
  if (Object.keys(value).some(key => !fields.includes(key)) || value.schemaVersion !== 1 || value.owner !== owner
    || value.agent !== agent || value.hookFile !== loc.hook || !Array.isArray(value.files)
    || typeof value.configRoot !== "string" || !value.configRoot.startsWith("/")
    || typeof value.stateRoot !== "string" || !value.stateRoot.startsWith("/")
    || typeof value.runtimeDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.runtimeDigest)
    || typeof value.afterHookFileDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.afterHookFileDigest)) return conflict("Invalid ownership manifest");
  if (value.mcp !== undefined) {
    const mcp = object(value.mcp);
    if (Object.keys(mcp).some(key => !["cwd", "scope", "selectionDigest"].includes(key))
      || typeof mcp.cwd !== "string" || !isAbsolute(mcp.cwd) || await safeAbsolute(mcp.cwd) !== mcp.cwd
      || !["user", "project"].includes(String(mcp.scope)) || agent === "codex" && mcp.scope !== "user"
      || typeof mcp.selectionDigest !== "string" || !/^[0-9a-f]{64}$/.test(mcp.selectionDigest)) return conflict("Invalid native MCP binding snapshot");
  }
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
  const cli = `${runtime}/dist/bin/modeck.mjs`;
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
    if (existing) return conflict("Unrecorded modeck destination already exists", existing);
    if (canonical(groups).includes(join(home, loc.private, "runtime"))) return conflict("Unrecorded modeck hook already exists");
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
  (home: string, image: FileImage | null, record: BindRecord | null) => Promise<Pick<BindPlan, "changes" | "mcp">>): Promise<BindPlan> => {
  if (process.platform === "win32") throw modeError("E_PLATFORM", "Installation supports macOS/Linux");
  const home = await safeAbsolute(targetHome);
  const inline = agent === "codex" ? await readImage(join(home, ".codex/config.toml"), LIMITS.jsonBytes).catch(() => null) : null;
  const warnings = agent === "codex" ? [diagnostic("CODEX_HOOK_TRUST", "Review and trust the installed definition in Codex /hooks; installation does not grant trust."),
    ...(inline && /\[\[?\s*hooks(?:\s*\.|\s*\])/.test(data(inline).toString("utf8"))
      ? [diagnostic("CODEX_INLINE_HOOKS", "Inline Codex hooks also load; review all sources to avoid duplicated modeck hooks.")] : [])]
    : [diagnostic("HOOK_FAILURE_NONBLOCKING", "Claude waits for SessionStart, but hook failures do not guarantee blocking the first request.")];
  try {
    await checkDirectory(home); await lockCheck(home, agent);
    const loc = locations(agent);
    await checkTarget(home, homePath(home, loc.hook));
    const image = await readImage(homePath(home, loc.hook), LIMITS.jsonBytes);
    if (image && data(image).includes(Buffer.from("GENERATED by evoloop"))) return conflict("evoloop owns the destination", loc.hook);
    const record = await loadRecord(home, agent);
    await verifyOwned(home, agent, record, shared(image).groups);
    const result = await build(home, image, record);
    return hashPlan({ schemaVersion: 1, operation, agent, targetHome: home, owner, ...result, conflicts: [], warnings: [...warnings,
      diagnostic("MCP_STATIC_SNAPSHOT", `${mcpSnapshotWarning}${agent === "codex" ? ` ${codexSnapshotWarning}` : ""}`)] });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "E_BUSY") throw error;
    return hashPlan({ schemaVersion: 1, operation, agent, targetHome: home, owner, changes: [],
      conflicts: [diagnostic("E_INSTALL_CONFLICT", error instanceof Error ? error.message : String(error))], warnings });
  }
};

export const planBind = async ({ agent, targetHome, configRoot, configRoots, stateRoot, runtimeRoot, cwd: suppliedCwd, scope }: PlanBindRequest): Promise<BindPlan> => {
  const cwd = await realpath(suppliedCwd ?? process.cwd());
  const prepared = await prepare({ agent, configRoot, ...(configRoots !== undefined ? { configRoots } : {}), stateRoot, cwd });
  return basePlan(agent, targetHome, "bind", async (home, before, previous) => {
    const nativeScope = scope ?? previous?.mcp?.scope ?? (agent === "codex" ? "user" : "project");
    const mcp = await planBindingMcp({ agent, targetHome: home, cwd, scope: nativeScope }, {
      desired: prepared.mcp.servers, configDigest: prepared.mcp.configDigest, provenance: prepared.mcp.provenance,
    });
    const loc = locations(agent);
    const packagePaths = ["dist/bin/modeck.mjs", "package.json", "schemas/modes.schema.json", "schemas/manifest.schema.json"].sort();
    const packageFiles = await Promise.all(packagePaths.map(async path => {
      const image = await readImage(join(runtimeRoot, path));
      if (!image) return conflict("Required runtime asset is missing", path);
      return { path, image: { ...image, mode: path === "dist/bin/modeck.mjs" || image.mode & 0o111 ? 0o755 : 0o644 } };
    }));
    const runtimeDigest = sha256(Buffer.from(canonical(packageFiles.map(file => ({ path: file.path, digest: digest(file.image), mode: file.image.mode })))));
    const runtime = `${loc.private}/runtime/${runtimeDigest}`;
    const owned = packageFiles.map(file => ({ path: `${runtime}/${file.path}`, image: file.image }));
    const group = await convertHookGroup(agent, hookGroup(agent, homePath(home, `${runtime}/dist/bin/modeck.mjs`), configRoot, stateRoot));
    const { root, groups } = shared(before);
    const nextGroups = previous ? groups.map(item => canonical(item) === canonical(previous.hookGroup) ? group : item) : [...groups, group];
    const nextRoot = replaceGroups(root, nextGroups);
    const hookImage = before && canonical(nextRoot) === canonical(root) ? before : jsonImage(nextRoot, before?.mode ?? 0o600);
    const beforeHookFile = previous ? before && (digest(before) !== previous.afterHookFileDigest
      || before.mode !== (previous.beforeHookFile?.mode ?? 0o600))
      ? jsonImage(replaceGroups(root, groups.filter(item => canonical(item) !== canonical(previous.hookGroup)),
        previous.beforeHookFile ? shared(previous.beforeHookFile).root : {}), before.mode)
      : previous.beforeHookFile : before;
    const record: BindRecord = { schemaVersion: 1, owner, agent, configRoot, stateRoot, runtimeDigest,
      mcp: { cwd, scope: nativeScope, selectionDigest: mcpSelectionDigest(agent, prepared.mcp.servers) },
      files: owned.map(file => ({ path: file.path, digest: digest(file.image), mode: file.image.mode })).sort((a, b) => a.path < b.path ? -1 : 1),
      hookFile: loc.hook, hookGroup: group, beforeHookFile,
      afterHookFileDigest: digest(hookImage) };
    const removed = previous?.files.filter(file => !record.files.some(next => next.path === file.path)) ?? [];
    return { mcp, changes: await changesFor(home, [...owned.map(file => ({ path: file.path, category: "owned" as const, after: file.image })),
      ...removed.map(file => ({ path: file.path, category: "owned" as const, after: null })),
      { path: loc.hook, category: "shared-json", after: hookImage }, { path: loc.record, category: "owned", after: jsonImage(record) }]) };
  });
};

export const planUnbind = async ({ agent, targetHome }: PlanUnbindRequest): Promise<BindPlan> => basePlan(agent, targetHome, "unbind", async (home, current, record) => {
  if (!record) return { changes: [] };
  const mcp = await planBindingMcp({ agent, targetHome: home, cwd: record.mcp?.cwd ?? home, scope: record.mcp?.scope ?? "user" });
  const loc = locations(agent);
  const { root, groups } = shared(current);
  const remaining = groups.filter(group => canonical(group) !== canonical(record.hookGroup));
  const image = current && digest(current) === record.afterHookFileDigest && current.mode === (record.beforeHookFile?.mode ?? 0o600) ? record.beforeHookFile
    : jsonImage(replaceGroups(root, remaining, record.beforeHookFile ? shared(record.beforeHookFile).root : {}), current?.mode ?? 0o600);
  return { mcp, changes: await changesFor(home, [{ path: loc.hook, category: "shared-json", after: image },
    ...record.files.map(file => ({ path: file.path, category: "owned" as const, after: null })),
    { path: loc.record, category: "owned", after: null }]) };
});

const removeEmpty = async (home: string, path: string): Promise<void> => {
  if (path === home || !path.startsWith(`${home}/`)) return;
  try { if ((await readdir(path)).length === 0) { await rmdir(path); await removeEmpty(home, dirname(path)); } }
  catch (error) { if (!missing(error) && !(error instanceof Error && "code" in error && error.code === "ENOTEMPTY")) throw error; }
};

const absoluteChanges = (plan: BindPlan): readonly FileChange[] => [
  ...plan.changes.map(change => ({ ...change, path: homePath(plan.targetHome, change.path) })), ...plan.mcp?.changes ?? [],
];

export const bindingPlanConflicts = (plans: readonly BindPlan[]): readonly Diagnostic[] => {
  const changes = plans.flatMap(absoluteChanges);
  const shared = changes.filter((change, index) => changes.slice(0, index).some(previous => previous.path === change.path
    && (previous.beforeDigest !== change.beforeDigest || previous.beforeMode !== change.beforeMode || !same(previous.after, change.after))))
    .map(change => diagnostic("E_INSTALL_CONFLICT", "Bindings require different ownership or contents in a shared native MCP file; use modeck config --scope user for separate agent stores", change.path));
  const topology = plans.flatMap(plan => {
    const transaction = plan.mcp;
    if (plan.agent !== "codebuddy" || !transaction) return [];
    const present = (path: string): boolean => transaction.observations.some(row => row.path === path && row.digest !== null);
    return transaction.locations.flatMap(request => Object.values(codebuddyMcpCandidates(request.targetHome, request.cwd)).flatMap(paths => {
      const selected = paths.find(present) ?? paths[0]!;
      const projected = paths.find(path => {
        const change = changes.find(change => change.path === path);
        return change ? change.after !== null : present(path);
      }) ?? paths[0]!;
      return selected === projected ? [] : [diagnostic("E_INSTALL_CONFLICT",
        "This transaction changes CodeBuddy MCP candidate precedence and would shadow an active scope; use modeck config --scope user for separate agent stores", projected)];
    }));
  });
  return [...shared, ...topology];
};

const withInstallLock = async <T>(home: string, agent: Agent, action: () => Promise<T>): Promise<T> => {
  await checkDirectory(home); await lockCheck(home, agent);
  const path = homePath(home, locations(agent).lock);
  const created = await ensureParents(home, path);
  const parent = await parentIdentity(path);
  const handle = await open(path, "wx", 0o600).catch(() => { throw modeError("E_BUSY", "Installation lock already exists"); });
  const identity = await handle.stat();
  let retained = false;
  try {
    await handle.writeFile(JSON.stringify({ schemaVersion: 1, owner, pid: process.pid }));
    await handle.close();
    return await action();
  } catch (error) {
    retained = error instanceof Error && "details" in error && (error.details as Record<string, unknown>).retainInstallLock === true;
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
    if (!retained) {
      const current = await lstat(path).catch(() => null);
      if (!current || current.dev !== identity.dev || current.ino !== identity.ino) throw modeError("E_INSTALL_CONFLICT", "Installation lock ownership changed; inspect the binding transaction", { retainInstallLock: true, path });
      await atomic(path, null, parent).catch(() => {
        throw modeError("E_INSTALL_CONFLICT", "Installation lock could not be released safely; inspect the binding transaction", { retainInstallLock: true, path });
      });
      await [...created].reverse().reduce(async (pending, directory) => { await pending; await removeEmpty(home, directory).catch(() => undefined); }, Promise.resolve());
      await removeEmpty(home, dirname(path)).catch(() => undefined);
    }
  }
};

export const applyBindPlans = async (input: readonly BindPlan[]): Promise<void> => {
  const plans = immutable(copyJson(input) as readonly BindPlan[]);
  if (!plans.length) return;
  const home = await safeAbsolute(plans[0]!.targetHome);
  if (new Set(plans.map(plan => plan.agent)).size !== plans.length || plans.some(plan => plan.targetHome !== home)) return conflict("Binding transaction requires unique agents in one home");
  const conflicts = bindingPlanConflicts(plans);
  if (conflicts.length) return conflict(conflicts[0]!.message, conflicts[0]!.path ?? undefined);
  const roots = new Map<string, string>();
  const nativePaths: string[] = [];
  for (const plan of plans) {
    const { planDigest, ...payload } = plan;
    if (plan.conflicts.length) return conflict("Installation plan contains conflicts");
    if (hashPlan(payload).planDigest !== planDigest) throw modeError("E_PLAN_STALE", "Installation plan digest changed");
    const loc = locations(plan.agent);
    plan.changes.forEach(change => {
      if (change.path !== loc.hook && change.path !== loc.record && !allowedOwned(plan.agent, change.path)) conflict("Plan contains an unowned path", change.path);
      roots.set(homePath(home, change.path), home);
    });
    if (plan.mcp) {
      const allowed = new Map<string, string>();
      for (const request of plan.mcp.locations) {
        if (request.agent !== plan.agent || request.targetHome !== home || request.cwd !== await safeAbsolute(request.cwd)) return conflict("Native MCP plan belongs to a different binding or unsafe cwd");
        const location = await mcpLocation(request);
        nativePaths.push(location.path);
        allowed.set(location.path, request.scope === "project" ? request.cwd : home);
        allowed.set(mcpRecordPath(home, location.path), home);
      }
      plan.mcp.changes.forEach(change => {
        const root = allowed.get(change.path);
        if (!root) return conflict("Plan contains an unowned native MCP path", change.path);
        roots.set(change.path, root);
      });
    }
  }
  const changes = [...new Map(plans.flatMap(absoluteChanges).map(change => [change.path, change])).values()];
  changes.forEach(change => {
    if (change.after && (!Number.isInteger(change.after.mode) || change.after.mode < 0 || change.after.mode > 0o777)) conflict("Plan has invalid file permissions");
  });
  const apply = async (): Promise<void> => {
    const before = new Map(await Promise.all(changes.map(async change => {
      await checkTarget(roots.get(change.path)!, change.path);
      const image = await readImage(change.path);
      if ((image ? digest(image) : null) !== change.beforeDigest || (image?.mode ?? null) !== change.beforeMode) throw modeError("E_PLAN_STALE", "Destination changed after planning", { path: change.path });
      if (change.category === "shared-json" && image && data(image).includes(Buffer.from("GENERATED by evoloop"))) conflict("evoloop owns this file", change.path);
      return [change.path, image] as const;
    })));
    await Promise.all(plans.flatMap(plan => plan.mcp ? [verifyBindingMcp(home, plan.mcp, nativePaths)] : []));
    const completed: { readonly path: string; readonly before: FileImage | null; readonly after: FileImage | null; readonly parent: ParentIdentity }[] = [];
    const directories = new Set<string>();
    let unsafeRollback = false;
    const priority = (change: FileChange): number => plans.some(plan => change.path === homePath(home, locations(plan.agent).record)) ? 2
      : plans.some(plan => change.path === homePath(home, locations(plan.agent).hook)) ? 1 : 0;
    try {
      await [...changes].sort((a, b) => priority(a) - priority(b)).reduce(async (pending, change) => {
        await pending;
        (await ensureParents(roots.get(change.path)!, change.path)).forEach(directory => directories.add(directory));
        await checkTarget(roots.get(change.path)!, change.path);
        if (!same(await readImage(change.path), before.get(change.path) ?? null)) throw modeError("E_PLAN_STALE", "Destination changed during apply", { path: change.path });
        const parent = await atomic(change.path, change.after);
        completed.push({ path: change.path, before: before.get(change.path) ?? null, after: change.after, parent });
      }, Promise.resolve());
    } catch (error) {
      const restored = await [...completed].reverse().reduce(async (pending, change) => {
        const prior = await pending;
        try {
          if (!same(await readImage(change.path), change.after)) return false;
          await atomic(change.path, change.before, change.parent);
          return prior;
        } catch { return false; }
      }, Promise.resolve(true));
      if (!restored) {
        unsafeRollback = true;
        throw modeError("E_INSTALL_CONFLICT", "Binding/MCP rollback could not safely restore every file; inspect retained installation and MCP locks", { retainInstallLock: true, retainMcpLock: true });
      }
      throw error;
    } finally {
      if (!unsafeRollback) await [...directories].sort((a, b) => b.length - a.length).reduce(async (pending, directory) => {
        await pending;
        if (directory.startsWith(`${home}/`)) await removeEmpty(home, directory).catch(() => undefined);
      }, Promise.resolve());
    }
    await Promise.all(changes.filter(change => change.after === null && change.path.startsWith(`${home}/`)).map(change => removeEmpty(home, dirname(change.path)).catch(() => undefined)));
  };
  const lockNative = (paths: readonly string[]): Promise<void> => paths.length ? withMcpLock(paths[0]!, () => lockNative(paths.slice(1))) : apply();
  const lockAgents = (agents: readonly Agent[]): Promise<void> => agents.length ? withInstallLock(home, agents[0]!, () => lockAgents(agents.slice(1)))
    : lockNative([...new Set(nativePaths)].sort());
  await lockAgents(plans.map(plan => plan.agent).sort());
};

export const applyBindPlan = async ({ plan, expectDigest }: ApplyBindPlanRequest): Promise<void> => {
  if (expectDigest !== undefined && expectDigest !== plan.planDigest) throw modeError("E_PLAN_STALE", "Installation plan digest changed");
  await applyBindPlans([plan]);
};

export const reverseBindPlans = async (plans: readonly BindPlan[]): Promise<readonly BindPlan[]> => {
  const changes = plans.flatMap(absoluteChanges);
  const reverseChange = async (change: FileChange): Promise<FileChange> => {
    const before = await readImage(change.path);
    if ((before ? digest(before) : null) !== change.beforeDigest || (before?.mode ?? null) !== change.beforeMode) throw modeError("E_PLAN_STALE", "Binding files changed before applying configuration");
    return { ...change, beforeDigest: change.after ? digest(change.after) : null, beforeMode: change.after?.mode ?? null, after: before };
  };
  const identityImages = await Promise.all(plans.flatMap(plan => plan.mcp?.locations ?? []).map(async request => {
    const path = (await mcpLocation(request)).path;
    return { path, change: changes.find(change => change.path === mcpRecordPath(request.targetHome, path)) };
  }));
  return Promise.all(plans.map(async ({ planDigest: _digest, ...plan }) => hashPlan({ ...plan, operation: plan.operation === "bind" ? "unbind" : "bind",
    changes: await Promise.all(plan.changes.map(async change => ({ ...await reverseChange({ ...change, path: homePath(plan.targetHome, change.path) }), path: change.path }))),
    ...(plan.mcp ? { mcp: { ...plan.mcp, defaultProfileOnly: false, changes: await Promise.all(plan.mcp.changes.map(reverseChange)),
      observations: plan.mcp.observations.map(value => {
        const change = changes.find(change => change.path === value.path);
        return change ? { path: value.path, digest: change.after ? digest(change.after) : null, mode: change.after?.mode ?? null } : value;
      }),
      identityTargets: [...new Set([...plan.mcp.identityTargets, ...identityImages.filter(value => value.change?.after).map(value => value.path)])]
        .filter(path => !identityImages.some(value => value.path === path && value.change?.after === null)).sort(),
    } } : {}),
  })));
};
