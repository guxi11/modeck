import { lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { canonical, isAgent, LIMITS, modeError, sha256 } from "../contracts/index.js";
import type { Agent, Diagnostic, FileImage, McpApplyRequest, McpBinding, McpDecision, McpLocationRequest, McpObservation, McpPlan, McpRequest, McpServers, McpStatus, McpTransaction } from "../contracts/index.js";
import { copyJson, immutable } from "../core/values.js";
import { atomic, checkDirectory, digest, ensureParents, imageJson, jsonImage, missing, object, readImage, safeAbsolute, same } from "./fs.js";
import type { ParentIdentity } from "./fs.js";
import { nativeMcpDefinitions, renderMcpServers, validateMcpEnvironment } from "./mcp-format.js";
import { assertMcpUnlocked, withMcpLock } from "./mcp-lock.js";
import { assertDefaultCodexProfile, checkMcpPolicy, mcpLocation, nativeImage, nativeRoot, nativeServers } from "./mcp-native.js";

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
export const mcpSnapshotWarning = "Native MCP is a static scope snapshot and does not isolate tools by mode. Mode selection controls only the modeck-owned server set; unmanaged native servers remain visible. Sessions sharing this scope may see its servers regardless of their selected mode. Before switching mode or working directory, stop active sessions, explicitly synchronize modeck config from the intended directory, then restart. Static scopes do not switch automatically with cwd or mode. Hooks cannot block startup, enforce tool visibility, or hot reload MCP.";
export const codexSnapshotWarning = "modeck synchronizes only the default Codex global user snapshot. Native --profile and trusted-project MCP are Codex capabilities outside modeck's supported binding scope; do not launch a bound session with --profile or -c/--config MCP overrides.";
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
export const mcpRecordPath = (home: string, path: string): string => join(home, ".local/share/modeck/mcp", `${hash(path)}.json`);
const recordPath = mcpRecordPath;
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

const inspect = async (request: McpRequest, heldPath?: string, cleanup = false) => {
  if (!/^[a-f0-9]{64}$/u.test(request.configDigest)) throw modeError("E_CONFIG", "Invalid MCP configuration digest");
  const targetHome = await safeAbsolute(request.targetHome);
  const cwd = await safeAbsolute(request.cwd);
  await checkDirectory(targetHome);
  await checkDirectory(cwd);
  const normalized: McpRequest = { agent: request.agent, targetHome, cwd, scope: request.scope ?? (request.agent === "codex" ? "user" : "project"),
    desired: request.desired, configDigest: request.configDigest,
    ...(request.provenance === undefined ? {} : { provenance: request.provenance }) };
  if (!cleanup) await assertDefaultCodexProfile(normalized);
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
      if (!cleanup && request.agent === "codex" && (otherRoot.profile !== undefined || otherRoot.profiles !== undefined
        || Object.keys(nativeServers(otherRoot, location.key)).length)) conflicts.push(diagnostic("modeck synchronizes only Codex's default user snapshot; profile and native project MCP layers are outside its supported scope", other));
      const otherServers = location.topLevel.includes(other) ? nativeServers(otherRoot, location.key) : {};
      const projects = other !== location.localStore || !Object.hasOwn(otherRoot, "projects") ? {} : object(otherRoot.projects);
      const localRoot = Object.hasOwn(projects, cwd) ? object(projects[cwd]) : {};
      const localServers = nativeServers(localRoot, location.key);
      Object.keys(desired).forEach(name => {
        const candidates = [otherServers, localServers].filter(map => Object.hasOwn(map, name)).map(map => map[name]);
        if (candidates.some(value => hash(value) !== hash(desired[name]))) conflicts.push(diagnostic("A different native scope defines this MCP server", other));
      });
    }));
    if (!cleanup && request.agent === "codex" && (root.profile !== undefined || root.profiles !== undefined)) conflicts.push(diagnostic("modeck requires Codex's default user snapshot; legacy profile tables require inspection", path));
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
    return { request: normalized, location, path, state, observations, servers, conflicts, image, after, recordImage, afterRecord };
  } finally { await assertMcpUnlocked(location.checks, heldPath); }
};

export const mcpSelectionDigest = (agent: Agent, selected: McpServers): string => hash(nativeMcpDefinitions(agent, selected));

const historicalLocation = async (agent: Agent, targetHome: string, cwd: string, path: string): Promise<McpLocationRequest> => {
  const user: McpLocationRequest = { agent, targetHome, cwd, scope: "user" };
  if ((await mcpLocation(user)).path === path) return user;
  const project: McpLocationRequest = { agent, targetHome, cwd: dirname(path), scope: "project" };
  if (agent !== "codex" && (await mcpLocation(project)).path === path) return project;
  throw modeError("E_INSTALL_CONFLICT", "A legacy owned MCP scope cannot be identified safely; inspect it before rebinding", { path });
};

export const planBindingMcp = async (location: McpLocationRequest, selection?: Pick<McpRequest, "desired" | "configDigest" | "provenance">): Promise<McpTransaction> => {
  const identities = await identityTargets(location.targetHome, []);
  const records = await identityRecords(location.targetHome, identities);
  const current = selection === undefined ? null : (await mcpLocation(location)).path;
  const prior = records.filter(record => Object.values(record.servers).some(server => server.agent === location.agent));
  const locations = [...(selection === undefined ? [] : [location]), ...await Promise.all(prior.filter(record => record.path !== current)
    .map(record => historicalLocation(location.agent, location.targetHome, location.cwd, record.path)))];
  const results = await Promise.all(locations.map(target => inspect({ ...target,
    ...(selection !== undefined && canonical(target) === canonical(location) ? selection : { desired: {}, configDigest: "0".repeat(64) }) }, undefined,
    selection === undefined || canonical(target) !== canonical(location))));
  const conflicts = results.flatMap(result => result.conflicts);
  if (conflicts.length) throw modeError("E_INSTALL_CONFLICT", conflicts.map(conflict => conflict.message).join("; "));
  // A different binding's unselected server remains visible in a shared static scope.
  if (selection !== undefined) {
    if (results[0]?.servers.some(server => server.ownerAgent !== null && server.ownerAgent !== location.agent
      && server.desiredDigest !== null)) throw modeError("E_INSTALL_CONFLICT", "Another binding owns a selected MCP server in the destination; use modeck config --scope user for separate agent stores");
    const active = (await mcpLocation(location)).topLevel;
    const remaining = records.filter(record => active.includes(record.path)).flatMap(record => Object.entries(record.servers)
      .filter(([name, server]) => server.agent !== location.agent && !Object.hasOwn(selection.desired, name)));
    if (remaining.length) throw modeError("E_INSTALL_CONFLICT", "Another binding owns unselected MCP servers in an active static scope; synchronize or unbind that owner first, then use modeck config --scope user for separate agent stores");
  }
  const changes = results.flatMap(result => [
    { path: result.path, before: result.image, after: result.after, category: "shared-json" as const },
    { path: result.state, before: result.recordImage, after: result.afterRecord, category: "owned" as const },
  ].filter(change => !same(change.before, change.after)).map(({ before, ...change }) => ({ ...change,
    beforeDigest: imageHash(before), beforeMode: before?.mode ?? null })));
  const observations = await observe([...results.flatMap(result => result.observations.map(value => value.path)),
    ...identities.map(path => recordPath(location.targetHome, path))]);
  if (results.some(result => result.observations.some(value => canonical(value) !== canonical(observations.find(row => row.path === value.path))))
    || canonical(identities) !== canonical(await identityTargets(location.targetHome, []))
    || canonical(results.map(result => result.location)) !== canonical(await Promise.all(locations.map(mcpLocation)))) {
    throw modeError("E_PLAN_STALE", "MCP configuration changed while planning binding");
  }
  return { locations, observations, topology: results.map(result => result.location), identityTargets: identities, changes,
    defaultProfileOnly: selection !== undefined && location.agent === "codex" };
};

export const verifyBindingMcp = async (home: string, transaction: McpTransaction, heldPaths: readonly string[]): Promise<void> => {
  const locations = await Promise.all(transaction.locations.map(mcpLocation));
  if (canonical(locations) !== canonical(transaction.topology)) throw modeError("E_PLAN_STALE", "Native MCP scope topology changed after binding planning");
  if (transaction.defaultProfileOnly) await Promise.all(transaction.locations.map(assertDefaultCodexProfile));
  await assertMcpUnlocked(locations.flatMap(location => location.checks), heldPaths);
  await Promise.all(transaction.locations.map(checkMcpPolicy));
  if (canonical(transaction.observations) !== canonical(await observe(transaction.observations.map(value => value.path)))
    || canonical(transaction.identityTargets) !== canonical(await identityTargets(home, []))) {
    throw modeError("E_PLAN_STALE", "Native MCP configuration or ownership changed after binding planning");
  }
  await Promise.all(transaction.locations.map(checkMcpPolicy));
  if (canonical(locations) !== canonical(await Promise.all(transaction.locations.map(mcpLocation)))) {
    throw modeError("E_PLAN_STALE", "Native MCP scope topology changed during binding validation");
  }
};

export const bindingMcpWarning = async (agent: Agent, targetHome: string, cwd: string, binding: McpBinding | undefined,
  selected: McpServers): Promise<string | null> => {
  const warning = `MCP selection is not synchronized with this native session. Previously loaded servers may remain available; do not use MCP tools in this session. ${mcpSnapshotWarning}${agent === "codex" ? ` ${codexSnapshotWarning}` : ""}`;
  try {
    if (!binding || binding.selectionDigest !== mcpSelectionDigest(agent, selected)
      || binding.scope === "project" && binding.cwd !== cwd) return warning;
    const location = { agent, targetHome, cwd, scope: binding.scope };
    await assertDefaultCodexProfile(location);
    const native = await inspectMcp(location, selected);
    if (agent === "codex") {
      const paths = await mcpLocation(location);
      const roots = await Promise.all(paths.active.map(async path => ({ path, root: nativeRoot(agent, await readImage(path)) })));
      if (roots.some(({ path, root }) => root.profile !== undefined || root.profiles !== undefined
        || path !== paths.path && Object.keys(nativeServers(root, paths.key)).length)) return warning;
    }
    const desired = nativeMcpDefinitions(agent, selected);
    return Object.entries(desired).some(([name, server]) => !Object.hasOwn(native, name) || hash(native[name]) !== hash(server)) ? warning : null;
  } catch { return warning; }
};

export const planMcp = async (request: McpRequest): Promise<McpPlan> => {
  const snapshot = snapshotMcpRequest(request);
  const result = await inspect(snapshot);
  const payload = { schemaVersion: 1 as const, owner: "modeck/mcp/1" as const, request: result.request,
    targetPath: result.path, recordPath: result.state, observations: result.observations,
    servers: result.servers, conflicts: result.conflicts,
    warnings: [{ code: "MCP_CONFIGURATION_ONLY", message: "Native configuration only: effective policy, authentication, connection, tool visibility and approval remain agent responsibilities.", path: null },
      { code: "MCP_STATIC_SNAPSHOT", message: `${mcpSnapshotWarning}${request.agent === "codex" ? ` ${codexSnapshotWarning}` : ""}`, path: null }] };
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
