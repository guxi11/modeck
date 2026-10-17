import { lstat, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { agents, canonical, LIMITS, modeError, sha256 } from "../contracts/index.js";
import type { Agent, BindPlan, BindRecord, ConfigRegistry, ConfigSourceRole, FileImage } from "../contracts/index.js";
import { loadConfig } from "../core/index.js";
import { applyBindPlans, bindingPlanConflicts, loadRecord, planBind, planUnbind, reverseBindPlans } from "../integration/install.js";
import { atomic, checkDirectory, digest, ensureParents, imageJson, jsonImage, missing, object, parentIdentity, readImage, safeAbsolute, same } from "../integration/fs.js";
import { loadRegistry, registryPath, registryRoot, sourceFor } from "../integration/registry.js";
import { prepare } from "../integration/prepare.js";
import { choose } from "./selection.js";

type Options = Readonly<Record<string, string | boolean>>;
type Snapshot = { readonly registry: ConfigRegistry; readonly image: FileImage | null; readonly records: readonly (BindRecord | null)[] };
const hash = (value: unknown): string => sha256(Buffer.from(canonical(value)));
const stale = (message: string): never => { throw modeError("E_PLAN_STALE", message); };

const snapshot = async (home: string, root: string): Promise<Snapshot> => {
  const image = await readImage(registryPath(root), LIMITS.jsonBytes);
  const registry = await loadRegistry(root);
  if (!same(image, await readImage(registryPath(root), LIMITS.jsonBytes))) return stale("Registry changed while reading");
  const records = await Promise.all(agents.map(agent => loadRecord(home, agent)));
  if (!registry && records.some(record => record?.configRoot === root)) {
    throw modeError("E_INSTALL_CONFLICT", "A binding references the registry directory but its registry is missing; restore it before changing configuration", { root });
  }
  return { image, records, registry: registry ?? { schemaVersion: 1,
    projects: [...new Set(records.flatMap(record => record && record.configRoot !== root ? [record.configRoot] : []))]
      .map(root => sourceFor({ root, enabled: true })) } };
};

const unchanged = async (home: string, root: string, before: Snapshot): Promise<void> => {
  if (!same(before.image, await readImage(registryPath(root), LIMITS.jsonBytes))
    || canonical(before.records) !== canonical(await Promise.all(agents.map(agent => loadRecord(home, agent))))) {
    stale("Registry or agent bindings changed after selection");
  }
};

const locked = async <T>(home: string, root: string, action: (retain: () => void) => Promise<T>): Promise<T> => {
  const path = join(root, "registry.lock");
  await checkDirectory(home);
  await ensureParents(home, path);
  const parent = await parentIdentity(path);
  const handle = await open(path, "wx", 0o600).catch(() => { throw modeError("E_BUSY", "Configuration management is in progress; inspect registry.lock if interrupted", { path }); });
  const identity = await handle.stat();
  const image = jsonImage({ owner: "modeck/v1", pid: process.pid, nonce: randomUUID() });
  let retained = false;
  try {
    await handle.writeFile(image.data);
    await handle.close();
    return await action(() => { retained = true; });
  } finally {
    await handle.close().catch(() => undefined);
    if (!retained) {
      const owned = await (async () => {
        const current = await lstat(path);
        return current.dev === identity.dev && current.ino === identity.ino && same(await readImage(path), image);
      })().catch(() => false);
      if (!owned) throw modeError("E_INSTALL_CONFLICT", "Registry lock changed during configuration management", { path });
      await atomic(path, null, parent);
    }
  }
};

const publish = async (root: string, before: FileImage | null, registry: ConfigRegistry): Promise<void> => {
  const path = registryPath(root);
  if (!same(before, await readImage(path, LIMITS.jsonBytes))) return stale("Registry changed before saving");
  const image = jsonImage(registry);
  if (Buffer.byteLength(image.data) > LIMITS.jsonBytes) throw modeError("E_LIMIT", "Registry exceeds byte limit");
  if (!same(before, image)) await atomic(path, image);
};

const answersFor = async (answers: string | undefined, before: Snapshot): Promise<{ readonly configs: readonly string[]; readonly agents: readonly Agent[] }> => {
  if (answers !== undefined) {
    const image = await readImage(await safeAbsolute(resolve(answers)), LIMITS.jsonBytes);
    if (!image) throw modeError("E_USAGE", "Answers file is missing");
    const value = object(imageJson(image));
    if (Object.keys(value).length !== 2 || !Array.isArray(value.configs) || !Array.isArray(value.agents)
      || !value.configs.every(root => typeof root === "string" && before.registry.projects.some(project => project.root === root))
      || !value.agents.every(agent => agents.includes(agent as Agent))
      || new Set(value.configs).size !== value.configs.length || new Set(value.agents).size !== value.agents.length) {
      throw modeError("E_USAGE", "Answers must be {configs:[registered absolute paths],agents:[claude|codex|codebuddy]} without duplicates");
    }
    return { configs: value.configs as string[], agents: value.agents as Agent[] };
  }
  const configs = before.registry.projects.length ? await choose("1/2 · Enable configuration projects (registration order)",
    before.registry.projects.map(project => ({ name: project.root, value: project.root, checked: project.enabled }))) : [];
  const selected = await choose("2/2 · Bind agents", agents.map((agent, index) => ({
    name: agent, value: agent, checked: before.records[index] !== null,
  })));
  return { configs, agents: selected };
};

export const manageConfig = async (command: "register" | "unregister" | "config", home: string, cwd: string, runtimeRoot: string,
  opts: Options): Promise<{ readonly conflicts?: boolean; readonly [key: string]: unknown }> => {
  const root = await safeAbsolute(registryRoot(home));
  const before = await snapshot(home, root);
  if (command === "config" && opts.list) {
    if (opts.answers || opts["dry-run"] || opts.expect) throw modeError("E_USAGE", "--list cannot be combined with --answers, --dry-run or --expect");
    return { ...before.registry, agents: agents.map((agent, index) => ({ agent, bound: before.records[index] !== null,
      configRoot: before.records[index]?.configRoot ?? null, stateRoot: before.records[index]?.stateRoot ?? null,
      mcp: before.records[index]?.mcp ?? null })) };
  }
  const expected = opts.expect;
  if (expected !== undefined && (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected))) throw modeError("E_USAGE", "Invalid expected plan digest");
  if (command !== "config") {
    const specified = resolve(String(opts.config ?? cwd));
    if (/\p{Cc}/u.test(specified)) throw modeError("E_PATH", "Expected an absolute safe path", { path: specified });
    if (command === "register" && specified.length > LIMITS.pathLength) throw modeError("E_PATH", "Configuration project path exceeds the registry limit", { maxLength: LIMITS.pathLength });
    const project = command === "register" ? await safeAbsolute(specified) : specified;
    if (project === root) throw modeError("E_CONFIG", "The registry directory cannot be registered as a configuration project");
    if (command === "unregister" && before.records.some(record => record?.configRoot === project)) {
      throw modeError("E_CONFIG", "Legacy agent bindings still reference this project; run modeck config before unregistering it", { project });
    }
    if (command === "unregister" && before.records.some(record => record?.configRoot === root)
      && before.registry.projects.some(entry => entry.root === project && entry.enabled)) {
      throw modeError("E_CONFIG", "Disable this configuration with modeck config before unregistering it; bound native MCP must be synchronized in the same transaction");
    }
    if (command === "register") await loadConfig({ configRoot: project });
    const exists = before.registry.projects.some(entry => entry.root === project);
    const metadata = command === "register" ? {
      ...(opts.role !== undefined ? { role: opts.role as ConfigSourceRole } : {}),
      ...(opts.namespace !== undefined ? { namespace: String(opts.namespace) } : {}),
    } : {};
    if (metadata.role !== undefined && !["personal", "team", "project"].includes(metadata.role)
      || metadata.namespace !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(metadata.namespace)) {
      throw modeError("E_USAGE", "Invalid configuration source role or namespace");
    }
    const registry: ConfigRegistry = { schemaVersion: 1, projects: command === "register"
      ? exists ? before.registry.projects.map(entry => entry.root === project ? sourceFor({ ...entry, ...metadata }) : entry)
        : [...before.registry.projects, sourceFor({ root: project, enabled: false, ...metadata })]
      : before.registry.projects.filter(entry => entry.root !== project) };
    if (registry.projects.length > LIMITS.modes) throw modeError("E_LIMIT", "Too many registered configuration projects");
    if (new Set(registry.projects.map(entry => entry.namespace)).size !== registry.projects.length) {
      throw modeError("E_CONFIG", "Duplicate configuration source namespace");
    }
    return locked(home, root, async () => {
      await unchanged(home, root, before);
      await publish(root, before.image, registry);
      return { ...registry, changed: canonical(registry) !== canonical(before.registry) };
    });
  }
  const selected = await answersFor(typeof opts.answers === "string" ? opts.answers : undefined, before);
  const registry: ConfigRegistry = { schemaVersion: 1, projects: before.registry.projects.map(project => ({
    ...project, enabled: selected.configs.includes(project.root),
  })) };
  const roots = registry.projects.filter(project => project.enabled).map(project => project.root);
  const stateFor = async (index: number): Promise<string> => safeAbsolute(resolve(String(opts.state ?? process.env.MODECK_STATE
    ?? before.records[index]?.stateRoot ?? join(home, ".local/share/modeck/v1"))));
  const validationAgents = agents.filter(agent => selected.agents.includes(agent));
  const fingerprints = async () => Promise.all((validationAgents.length ? validationAgents : ["codex" as const]).map(async agent => {
    const stateRoot = await stateFor(agents.indexOf(agent));
    const prepared = await prepare({ agent, configRoot: root, configRoots: roots, stateRoot, cwd });
    return { agent, stateRoot, configDigest: prepared.plan.configDigest, resourceDigest: prepared.plan.resourceDigest,
      selectionDigest: prepared.rendered.selectionDigest, contentDigest: prepared.rendered.contentDigest, mcpDigest: prepared.mcp.configDigest };
  }));
  const prepared = await fingerprints();
  const plans = await agents.reduce(async (pending, agent, index) => {
    const previous = await pending;
    const record = before.records[index];
    if (!selected.agents.includes(agent) && !record) return previous;
    const stateRoot = await stateFor(index);
    const plan = selected.agents.includes(agent)
      ? await planBind({ agent, targetHome: home, configRoot: root, stateRoot, runtimeRoot, configRoots: roots, cwd,
        ...(typeof opts.scope === "string" ? { scope: opts.scope as "user" | "project" } : {}) })
      : await planUnbind({ agent, targetHome: home });
    return [...previous, plan];
  }, Promise.resolve([] as readonly BindPlan[]));
  const planDigest = hash({ schemaVersion: 1, targetHome: home, registryPath: registryPath(root),
    before: before.image ? { digest: digest(before.image), mode: before.image.mode } : null, registry, plans,
    fingerprints: prepared });
  if (expected !== undefined && expected !== planDigest) return stale("Configuration plan digest changed");
  const sharedConflicts = bindingPlanConflicts(plans);
  const conflicts = sharedConflicts.length > 0 || plans.some(plan => plan.conflicts.length > 0);
  const result = { ...registry, plans: plans.map(plan => ({ ...plan, changes: plan.changes.map(({ after, ...change }) => ({
    ...change, afterDigest: after ? digest(after) : null, afterMode: after?.mode ?? null,
  })), ...(plan.mcp ? { mcp: { ...plan.mcp, changes: plan.mcp.changes.map(({ after, ...change }) => ({
    ...change, afterDigest: after ? digest(after) : null, afterMode: after?.mode ?? null,
  })) } } : {}), conflicts: [...plan.conflicts, ...sharedConflicts] })), planDigest, conflicts, applied: !opts["dry-run"] && !conflicts };
  if (opts["dry-run"] || conflicts) return result;
  return locked(home, root, async retain => {
    await unchanged(home, root, before);
    if (canonical(await fingerprints()) !== canonical(prepared)) {
      return stale("Selected configuration content changed after planning");
    }
    const inverses = await reverseBindPlans(plans);
    let completed = false;
    try {
      await applyBindPlans(plans);
      completed = true;
      await publish(root, before.image, registry);
      return result;
    } catch (error) {
      const restored = await (async () => {
        if (!completed) return true;
        try { await applyBindPlans(inverses); return true; } catch { return false; }
      })();
      const interrupted = error instanceof Error && "code" in error && error.code === "E_INSTALL_CONFLICT"
        && (await Promise.all(plans.map(async plan => {
          try { await lstat(join(home, ".modeck", plan.agent, "install.lock")); return true; }
          catch (caught) { return !missing(caught); }
        }))).some(Boolean);
      if (!restored || interrupted) {
        retain();
        throw modeError("E_INSTALL_CONFLICT", "Configuration installation or rollback was interrupted; inspect registry.lock and agent installation locks", { cause: String(error), root });
      }
      throw error;
    }
  });
};
