import { lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { canonical, isAgent, LIMITS, modeError, sha256 } from "../contracts/index.js";
import type { Agent, Diagnostic, FileImage, McpApplyRequest, McpDecision, McpLocationRequest, McpObservation, McpPlan, McpRequest, McpServers, McpStatus } from "../contracts/index.js";
import { copyJson, immutable } from "../core/values.js";
import { atomic, checkDirectory, digest, ensureParents, imageJson, jsonImage, missing, object, readImage, safeAbsolute, same } from "./fs.js";
import type { ParentIdentity } from "./fs.js";
import { nativeMcpDefinitions, renderMcpServers, validateMcpEnvironment } from "./mcp-format.js";
import { assertMcpUnlocked, withMcpLock } from "./mcp-lock.js";
import { checkMcpPolicy, mcpLocation, nativeImage, nativeRoot, nativeServers } from "./mcp-native.js";

export { renderMcpServers, validateMcpEnvironment } from "./mcp-format.js";
export { assertMcpPolicy, checkMcpPolicy } from "./mcp-native.js";
export { mcpLockPath, withMcpLock } from "./mcp-lock.js";
export type { McpApplyRequest, McpDecision, McpLocationRequest, McpObservation, McpPlan, McpPlanRequest, McpRequest, McpScope, McpServers, McpStatus } from "../contracts/index.js";
type OwnedServer = Readonly<{ agent: Agent; digest: string; endpointDigest: string }>;
type Ownership = Readonly<{ schemaVersion: 1; owner: "modeck/mcp/1"; path: string;
  servers: Readonly<Record<string, OwnedServer>>; retired: Readonly<Record<string, string>> }>;
const hash = (value: unknown): string => sha256(Buffer.from(canonical(value)));
const imageHash = (image: FileImage | null): string | null => image ? digest(image) : null;
const diagnostic = (message: string, path: string | null = null): Diagnostic => ({ code: "E_INSTALL_CONFLICT", message, path });
const snapshotMcpRequest = (request: McpRequest): McpRequest => {
  if (Object.keys(object(request)).some(key => !["agent", "targetHome", "cwd", "scope", "desired", "configDigest", "provenance"].includes(key))) {
    throw modeError("E_CONFIG", "Unsupported MCP request field");
  }
  const snapshot = immutable(copyJson(request) as McpRequest);
  validateMcpEnvironment(snapshot.desired);
  const provenance = snapshot.provenance;
  if (provenance !== undefined) {
    if (!Array.isArray(provenance) || provenance.length > LIMITS.modes * LIMITS.modes) throw modeError("E_CONFIG", "Invalid MCP provenance");
    provenance.forEach(row => {
      if (!row || typeof row !== "object" || Array.isArray(row)
        || Object.keys(row).some(key => !["server", "root", "role", "namespace", "modeIds", "action"].includes(key))
        || typeof row.server !== "string" || !Object.hasOwn(snapshot.desired, row.server)
        || typeof row.root !== "string" || !isAbsolute(row.root) || row.root.length > LIMITS.pathLength || /\p{Cc}/u.test(row.root)
        || !["personal", "team", "project"].includes(row.role)
        || typeof row.namespace !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(row.namespace)
        || !["select", "deduplicate", "override"].includes(row.action)
        || !Array.isArray(row.modeIds) || row.modeIds.length > LIMITS.modes
        || row.modeIds.some((mode: unknown) => typeof mode !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(mode))) {
        throw modeError("E_CONFIG", "Invalid MCP provenance");
      }
    });
  }
  return snapshot;
};
const recordPath = (home: string, path: string): string => join(home, ".local/share/modeck/mcp", `${hash(path)}.json`);
const endpointHash = (server: unknown): string => {
  const value = object(server);
  return hash(typeof value.url === "string" ? { url: value.url } : { command: value.command, args: value.args ?? [] });
};
const readOwnership = async (path: string, target: string): Promise<Ownership> => {
  const image = await readImage(path);
  if (!image) return { schemaVersion: 1, owner: "modeck/mcp/1", path: target, servers: {}, retired: {} };
  if (image.mode !== 0o600 || (await lstat(path)).uid !== process.getuid?.()) throw modeError("E_INSTALL_CONFLICT", "MCP ownership record is not private");
  const root = object(imageJson(image));
  if (Object.keys(root).some(key => !["schemaVersion", "owner", "path", "servers", "retired"].includes(key))
    || root.schemaVersion !== 1 || root.owner !== "modeck/mcp/1" || root.path !== target) throw modeError("E_INSTALL_CONFLICT", "Invalid MCP ownership record");
  const servers = object(root.servers);
  Object.entries(servers).forEach(([name, raw]) => {
    const value = object(raw);
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name) || Object.keys(value).some(key => !["agent", "digest", "endpointDigest"].includes(key))
      || !isAgent(value.agent)
      || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.digest)
      || typeof value.endpointDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.endpointDigest)) throw modeError("E_INSTALL_CONFLICT", "Invalid owned MCP server");
  });
  const retired = root.retired === undefined ? {} : object(root.retired);
  if (Object.entries(retired).some(([name, value]) => !/^[a-z][a-z0-9-]{0,63}$/u.test(name)
    || typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))) throw modeError("E_INSTALL_CONFLICT", "Invalid retired MCP identity");
  return { ...root, retired } as unknown as Ownership;
};
const observe = async (paths: readonly string[]): Promise<readonly McpObservation[]> => Promise.all([...new Set(paths)].sort().map(async path => {
  const image = await readImage(path);
  return { path, digest: imageHash(image), mode: image?.mode ?? null };
}));
const identityRecords = (home: string, targets: readonly string[]): Promise<readonly Ownership[]> =>
  Promise.all(targets.map(target => readOwnership(recordPath(home, target), target)));
const identityTargets = async (home: string, candidates: readonly string[]): Promise<readonly string[]> => {
  const directory = join(home, ".local/share/modeck/mcp");
  await checkDirectory(directory);
  const files = await readdir(directory).catch(error => { if (missing(error)) return []; throw error; });
  const targets = await Promise.all(files.filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).map(async name => {
    const path = join(directory, name);
    const image = await readImage(path);
    if (!image) throw modeError("E_PLAN_STALE", "MCP identity history changed while reading");
    const root = object(imageJson(image));
    if (typeof root.path !== "string" || recordPath(home, root.path) !== path) throw modeError("E_INSTALL_CONFLICT", "Invalid MCP identity history");
    return root.path;
  }));
  return [...new Set([...candidates, ...targets])].sort();
};
const changedIdentity = (records: readonly Ownership[], desired: Readonly<Record<string, unknown>>): boolean => records.some(record =>
  Object.entries(desired).some(([name, value]) => {
    const previous = Object.hasOwn(record.servers, name) ? record.servers[name]!.endpointDigest
      : Object.hasOwn(record.retired, name) ? record.retired[name] : undefined;
    return previous !== undefined && previous !== endpointHash(value);
  }));

export const assertMcpSelection = async (request: McpLocationRequest, selected: McpServers): Promise<void> => {
  const location = await mcpLocation(request);
  await assertMcpUnlocked(location.checks);
  try {
    const paths = location.topLevel.map(path => recordPath(request.targetHome, path));
    const before = await observe(paths);
    const records = await identityRecords(request.targetHome, location.topLevel);
    const stale = records.flatMap(record => Object.entries(record.servers)
      .filter(([name]) => !Object.hasOwn(selected, name))
      .map(([name, owned]) => ({ name, ownerAgent: owned.agent, path: record.path })));
    if (stale.length) throw modeError("E_INSTALL_CONFLICT", `Unselected modeck-owned MCP servers remain: ${stale.map(server => `${server.name} (${server.ownerAgent})`).join(", ")}; explicitly apply removal with each owner agent before running`, { servers: stale });
    if (canonical(before) !== canonical(await observe(paths))
      || canonical(location.topLevel) !== canonical((await mcpLocation(request)).topLevel)) {
      throw modeError("E_PLAN_STALE", "Managed MCP selection changed while reading");
    }
  } finally { await assertMcpUnlocked(location.checks); }
};

export const inspectMcp = async (request: McpLocationRequest, selected?: McpServers): Promise<Readonly<Record<string, unknown>>> => {
  if (selected !== undefined) await assertMcpSelection(request, selected);
  const policies = await checkMcpPolicy(request);
  const location = await mcpLocation(request);
  await assertMcpUnlocked(location.checks);
  try {
    const identities = await identityTargets(request.targetHome, location.checks);
    const before = await observe([...location.checks, ...policies, ...identities.map(path => recordPath(request.targetHome, path))]);
    const scopes = await Promise.all(location.active.map(async path => {
      const root = nativeRoot(request.agent, await readImage(path));
      const projects = path !== location.localStore || !Object.hasOwn(root, "projects") ? {} : object(root.projects);
      const local = Object.hasOwn(projects, request.cwd) ? object(projects[request.cwd]) : {};
      return { path, top: location.topLevel.includes(path) ? nativeServers(root, location.key) : {}, local: nativeServers(local, location.key) };
    }));
    const maps = [...location.topLevel.map(path => scopes.find(scope => scope.path === path)!.top), ...scopes.map(scope => scope.local)];
    const desired = selected === undefined ? null : nativeMcpDefinitions(request.agent, selected);
    if (desired !== null && changedIdentity(await identityRecords(request.targetHome, identities), desired)) {
      throw modeError("E_INSTALL_CONFLICT", "An MCP name belongs to a different endpoint identity; use a new name");
    }
    const result = maps.reduce<Record<string, unknown>>((previous, map) => Object.entries(map).reduce((merged, [name, value]) => {
      if (desired !== null && Object.hasOwn(desired, name) && hash(desired[name]) !== hash(value)
        || desired === null && Object.hasOwn(merged, name) && hash(merged[name]) !== hash(value)) {
        throw modeError("E_INSTALL_CONFLICT", "Native MCP scopes define different servers with the same name");
      }
      return { ...merged, [name]: value };
    }, previous), {});
    if (canonical(before) !== canonical(await observe(before.map(value => value.path)))) throw modeError("E_PLAN_STALE", "Native MCP configuration changed while reading");
    if (canonical(identities) !== canonical(await identityTargets(request.targetHome, location.checks))) throw modeError("E_PLAN_STALE", "MCP identity history changed while reading");
    await checkMcpPolicy(request);
    return result;
  } finally { await assertMcpUnlocked(location.checks); }
};

const inspect = async (request: McpRequest, heldPath?: string) => {
  if (!/^[a-f0-9]{64}$/u.test(request.configDigest)) throw modeError("E_CONFIG", "Invalid MCP configuration digest");
  const targetHome = await safeAbsolute(request.targetHome);
  const cwd = await safeAbsolute(request.cwd);
  await checkDirectory(targetHome);
  await checkDirectory(cwd);
  const normalized: McpRequest = { agent: request.agent, targetHome, cwd, scope: request.scope ?? "user",
    desired: request.desired, configDigest: request.configDigest,
    ...(request.provenance === undefined ? {} : { provenance: request.provenance }) };
  const policyPaths = await checkMcpPolicy(normalized);
  const location = await mcpLocation(normalized);
  await assertMcpUnlocked(location.checks, heldPath);
  try {
    const path = location.path;
    const state = recordPath(targetHome, path);
    const identities = await identityTargets(targetHome, location.checks);
    const observations = await observe([...location.checks, ...policyPaths, ...identities.map(path => recordPath(targetHome, path)), state]);
    const image = await readImage(path);
    if (image && (image.mode & 0o022 || (await lstat(path)).uid !== process.getuid?.())) throw modeError("E_INSTALL_CONFLICT", "Native MCP configuration has unsafe ownership or permissions");
    const root = nativeRoot(request.agent, image);
    const current = nativeServers(root, location.key);
    const desired = await renderMcpServers(request.agent, request.desired);
    const owned = await readOwnership(state, path);
    const conflicts: Diagnostic[] = [];
    if (changedIdentity(await identityRecords(targetHome, identities), desired)) {
      conflicts.push(diagnostic("An MCP name belongs to a different endpoint identity in this home; use a new name", path));
    }
    const ownProjects = path !== location.localStore || !Object.hasOwn(root, "projects") ? {} : object(root.projects);
    const ownLocal = Object.hasOwn(ownProjects, cwd) ? object(ownProjects[cwd]) : {};
    const ownLocalServers = nativeServers(ownLocal, location.key);
    if (Object.keys(desired).some(name => Object.hasOwn(ownLocalServers, name) && hash(ownLocalServers[name]) !== hash(desired[name]))) {
      conflicts.push(diagnostic("A local native MCP definition takes precedence", path));
    }
    // Every active scope is inspected, but none is copied into a plan or state record.
    await Promise.all(location.active.filter(other => other !== path).map(async other => {
      const otherRoot = nativeRoot(request.agent, await readImage(other));
      if (request.agent === "codex" && otherRoot.profile !== undefined) conflicts.push(diagnostic("An active Codex profile requires explicit native configuration", other));
      const otherServers = location.topLevel.includes(other) ? nativeServers(otherRoot, location.key) : {};
      const projects = other !== location.localStore || !Object.hasOwn(otherRoot, "projects") ? {} : object(otherRoot.projects);
      const localRoot = Object.hasOwn(projects, cwd) ? object(projects[cwd]) : {};
      const localServers = nativeServers(localRoot, location.key);
      Object.keys(desired).forEach(name => {
        const candidates = [otherServers, localServers].filter(map => Object.hasOwn(map, name)).map(map => map[name]);
        if (candidates.some(value => hash(value) !== hash(desired[name]))) conflicts.push(diagnostic("A different native scope defines this MCP server", other));
      });
    }));
    if (request.agent === "codex" && (root.profile !== undefined || root.profiles !== undefined)) conflicts.push(diagnostic("Codex profiles require an explicit native profile target", path));
    const servers: readonly McpDecision[] = [...new Set([...Object.keys(owned.servers), ...Object.keys(desired)])].sort().map(name => {
      const previous = Object.hasOwn(owned.servers, name) ? owned.servers[name] : undefined;
      const present = Object.hasOwn(current, name) ? current[name] : undefined;
      const next = Object.hasOwn(desired, name) ? desired[name] : undefined;
      const currentDigest = present === undefined ? null : hash(present);
      const desiredDigest = next === undefined ? null : hash(next);
      const base = { name, ownerAgent: previous?.agent ?? null, ownedDigest: previous?.digest ?? null, currentDigest, desiredDigest };
      if (next !== undefined && Object.hasOwn(owned.retired, name) && owned.retired[name] !== endpointHash(next)) {
        conflicts.push(diagnostic("A retired MCP server name cannot target a different endpoint; use a new name", path));
        return { ...base, action: "conflict" };
      }
      if (previous && currentDigest !== previous.digest) {
        conflicts.push(diagnostic("Owned MCP server drifted; refusing to overwrite or delete", path));
        return { ...base, action: "conflict" };
      }
      if (previous && previous.agent !== request.agent) {
        if (next === undefined || currentDigest === desiredDigest) return { ...base, action: "keep" };
        conflicts.push(diagnostic("Another agent owns this MCP server; refusing to modify it", path));
        return { ...base, action: "conflict" };
      }
      if (!previous && present !== undefined && currentDigest !== desiredDigest) {
        conflicts.push(diagnostic("Unmanaged MCP server name is occupied", path));
        return { ...base, action: "conflict" };
      }
      if (previous && next !== undefined && endpointHash(next) !== previous.endpointDigest) {
        conflicts.push(diagnostic("MCP endpoint changed; use a new name to preserve native credential isolation", path));
        return { ...base, action: "conflict" };
      }
      return { ...base, action: next === undefined ? "remove" : currentDigest === desiredDigest ? "keep" : present === undefined ? "add" : "update" };
    });
    const afterServers = servers.reduce<Record<string, unknown>>((result, server) => server.action === "remove"
      ? Object.fromEntries(Object.entries(result).filter(([name]) => name !== server.name))
      : ["add", "update"].includes(server.action) ? { ...result, [server.name]: desired[server.name] } : result, { ...current });
    const afterOwned = servers.reduce<Record<string, OwnedServer>>((result, server) => server.action === "remove"
      ? Object.fromEntries(Object.entries(result).filter(([name]) => name !== server.name))
      : ["add", "update"].includes(server.action) || server.action === "keep" && server.ownerAgent === request.agent
        ? { ...result, [server.name]: { agent: request.agent, digest: hash(desired[server.name]), endpointDigest: endpointHash(desired[server.name]) } }
        : result, { ...owned.servers });
    const after = canonical(current) === canonical(afterServers) ? image : nativeImage(request.agent, { ...root, [location.key]: afterServers }, image?.mode ?? 0o600, image);
    // Native OAuth stores outlive config removal, so deleting a server must not erase its identity.
    const retired = servers.reduce<Record<string, string>>((previous, server) => server.action === "remove"
      ? { ...previous, [server.name]: owned.servers[server.name]!.endpointDigest } : previous, { ...owned.retired });
    const record: Ownership = { ...owned, servers: afterOwned, retired };
    const recordImage = await readImage(state);
    const afterRecord = canonical(record) === canonical(owned) && recordImage ? recordImage
      : Object.keys(afterOwned).length ? jsonImage(record) : recordImage ? jsonImage(record) : null;
    if (canonical(await observe(observations.map(value => value.path))) !== canonical(observations)) throw modeError("E_PLAN_STALE", "MCP configuration changed while planning");
    if (canonical(identities) !== canonical(await identityTargets(targetHome, location.checks))) throw modeError("E_PLAN_STALE", "MCP identity history changed while planning");
    await checkMcpPolicy(normalized);
    return { request: normalized, path, state, observations, servers, conflicts, image, after, recordImage, afterRecord };
  } finally { await assertMcpUnlocked(location.checks, heldPath); }
};

export const planMcp = async (request: McpRequest): Promise<McpPlan> => {
  const snapshot = snapshotMcpRequest(request);
  const result = await inspect(snapshot);
  const payload = { schemaVersion: 1 as const, owner: "modeck/mcp/1" as const, request: result.request,
    targetPath: result.path, recordPath: result.state, observations: result.observations,
    servers: result.servers, conflicts: result.conflicts,
    warnings: [{ code: "MCP_CONFIGURATION_ONLY", message: "Native configuration only: effective policy, authentication, connection, tool visibility and approval remain agent responsibilities.", path: null }] };
  return { ...payload, planDigest: hash(payload) };
};

export const applyMcpPlan = async (input: McpApplyRequest): Promise<void> => {
  // Copy and freeze before the first await; caller mutations cannot alter an approved write.
  const { plan, expectDigest } = immutable(copyJson(input) as McpApplyRequest);
  const request = snapshotMcpRequest(plan.request);
  const { planDigest, ...payload } = plan;
  if (hash(payload) !== planDigest || expectDigest !== undefined && expectDigest !== planDigest) {
    throw modeError("E_PLAN_STALE", "MCP plan digest changed");
  }
  if (plan.conflicts.length) throw modeError("E_INSTALL_CONFLICT", "MCP plan contains conflicts");
  const expectedLocation = await mcpLocation(request);
  if (plan.targetPath !== expectedLocation.path || plan.recordPath !== recordPath(request.targetHome, expectedLocation.path)) throw modeError("E_PLAN_STALE", "MCP plan target changed");
  await ensureParents(request.scope === "project" ? request.cwd : request.targetHome, plan.targetPath);
  await withMcpLock(plan.targetPath, async () => {
    const current = await inspect(request, plan.targetPath);
    if (canonical(current.observations) !== canonical(plan.observations) || canonical(current.servers) !== canonical(plan.servers)
      || current.conflicts.length) throw modeError("E_PLAN_STALE", "MCP configuration changed after planning");
    const changes = [{ path: current.path, before: current.image, after: current.after },
      { path: current.state, before: current.recordImage, after: current.afterRecord }].filter(change => !same(change.before, change.after));
    const completed: (typeof changes[number] & { parent: ParentIdentity })[] = [];
    try {
      await changes.reduce(async (pending, change) => {
        await pending;
        await ensureParents(change.path === current.path && request.scope === "project" ? request.cwd : request.targetHome, change.path);
        await checkDirectory(dirname(change.path));
        if (!same(await readImage(change.path), change.before)) throw modeError("E_PLAN_STALE", "MCP file changed during apply");
        const parent = await atomic(change.path, change.after);
        completed.push({ ...change, parent });
      }, Promise.resolve());
    } catch (error) {
      const restored = await [...completed].reverse().reduce(async (pending, change) => {
        const previous = await pending;
        try {
          if (!same(await readImage(change.path), change.after)) return false;
          await atomic(change.path, change.before, change.parent);
          return previous;
        } catch { return false; }
      }, Promise.resolve(true));
      if (!restored) throw modeError("E_INSTALL_CONFLICT", "MCP rollback could not safely restore every file; shared lock retained", { retainMcpLock: true });
      throw error;
    }
  });
};

export const mcpStatus = async (request: McpRequest): Promise<McpStatus> => {
  const plan = await planMcp(request);
  return { schemaVersion: 1 as const, agent: plan.request.agent, targetPath: plan.targetPath,
    configDigest: plan.request.configDigest, provenance: plan.request.provenance ?? [],
    servers: plan.servers, conflicts: plan.conflicts, warnings: plan.warnings,
    configuration: plan.conflicts.length ? "conflict" : plan.servers.every(server => server.action === "keep") ? "matches" : "changes-required",
    policy: "unknown", connection: "unknown", tools: "unknown", approval: "unknown" };
};
