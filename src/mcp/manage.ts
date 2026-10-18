import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { canonical, modeError, sha256 } from "../contracts/index.js";
import type { FileImage } from "../contracts/index.js";
import type { StaticMcpConfig, StaticMcpDecision, StaticMcpRequest, StaticMcpServer, StaticMcpSummary } from "../contracts/mcp-static.js";
import { checkDirectory, imageJson, jsonImage, object, readImage, same } from "../integration/fs.js";
import { centralImage, checkedConfig, parseCentral, serverName } from "./config.js";
import { decodeServer, encodeServer, equivalent, locate, mergeImage, nativeRoot, nativeServers } from "./native.js";
import { assertNoJournal, ownershipPath, recover, transact } from "./transaction.js";
import type { Change } from "./transaction.js";

type Owned = Readonly<{ digest: string; endpoint: string }>;
type Ownership = Readonly<{ schemaVersion: 1; owner: "modeck/static-mcp/1"; target: string; agent: string; source: string;
  servers: Readonly<Record<string, Owned>> }>;
type Observed = Readonly<{ path: string; image: FileImage | null }>;
const hash = (value: unknown): string => sha256(Buffer.from(canonical(value)));
const legacyEndpoint = (server: unknown): string => {
  const value = object(server);
  return hash(Object.hasOwn(value, "command") ? { command: value.command, args: value.args ?? [] }
    : { transport: value.type ?? value.transport ?? "http", url: value.url });
};
const priorEndpoint = (server: unknown): string => {
  const value = object(server);
  const identity = Object.hasOwn(value, "command")
    ? { command: value.command, args: value.args ?? [], ...(Object.hasOwn(value, "cwd") ? { cwd: value.cwd } : {}) }
    : { transport: value.type ?? value.transport ?? "http", url: value.url };
  return hash({ ...identity, ...(Object.hasOwn(value, "http_headers_helper") ? { http_headers_helper: value.http_headers_helper } : {}) });
};
const legacyEndpoints = (server: unknown): readonly string[] => {
  const value = object(server);
  const candidates = [() => legacyEndpoint(value), () => priorEndpoint(value),
    ...(Object.hasOwn(value, "url") ? [() => hash({ transport: value.type ?? "http", url: value.url })] : [])];
  return candidates.flatMap(candidate => { try { return [candidate()]; } catch { return []; } });
};
const endpoint = (server: unknown): string => {
  const value = object(server);
  const identity: Record<string, unknown> = {};
  for (const key of ["command", "args", "url", "type", "transport", "cwd", "http_headers_helper"] as const) {
    if (Object.hasOwn(value, key)) identity[key] = value[key];
  }
  if (Object.hasOwn(value, "command")) {
    identity.args = value.args ?? [];
    if ((value.type === undefined || value.type === "stdio")
      && (value.transport === undefined || value.transport === "stdio")) {
      identity.type = "stdio";
      delete identity.transport;
    }
  }
  return hash(identity);
};
const observe = (paths: readonly string[]): Promise<readonly Observed[]> => Promise.all([...new Set(paths)].sort().map(async path => ({ path, image: await readImage(path) })));
const verifyObserved = async (expected: readonly Observed[], written: readonly Change[] = []): Promise<void> => {
  for (const item of expected) {
    const change = written.find(change => change.path === item.path);
    if (!same(await readImage(item.path), change ? change.after : item.image)) {
      throw modeError("E_PLAN_STALE", "MCP source, target, policy or ownership changed; rerun status before applying");
    }
  }
};
const safeNative = async (path: string, image: FileImage | null): Promise<void> => {
  if (!image) return;
  const stat = await lstat(path);
  if (stat.uid !== process.getuid?.() || image.mode & 0o022 || stat.nlink !== 1) throw modeError("E_INSTALL_CONFLICT", "MCP source/target must be owned by this user, singly linked and not writable by others");
};
const readOwned = async (image: FileImage | null, request: StaticMcpRequest, target: string, source: string): Promise<Ownership> => {
  if (!image) return { schemaVersion: 1, owner: "modeck/static-mcp/1", target, agent: request.agent, source, servers: {} };
  if (image.mode !== 0o600) throw modeError("E_INSTALL_CONFLICT", "MCP ownership metadata must have mode 0600");
  const root = object(imageJson(image));
  if (Object.keys(root).some(key => !["schemaVersion", "owner", "target", "agent", "source", "servers"].includes(key))
    || root.schemaVersion !== 1 || root.owner !== "modeck/static-mcp/1" || root.target !== target || root.agent !== request.agent
    || root.source !== source) throw modeError("E_INSTALL_CONFLICT", "This native target has ownership from another agent/configuration; keep its existing owner and use the original --config");
  const servers = object(root.servers);
  for (const [name, raw] of Object.entries(servers)) {
    const entry = object(raw);
    if (!serverName(name) || Object.keys(entry).length !== 2 || typeof entry.digest !== "string" || !/^[a-f0-9]{64}$/u.test(entry.digest)
      || typeof entry.endpoint !== "string" || !/^[a-f0-9]{64}$/u.test(entry.endpoint)) throw modeError("E_CONFIG", "Invalid MCP ownership entry");
  }
  return root as unknown as Ownership;
};
const summary = (action: string, request: StaticMcpRequest, decisions: readonly StaticMcpDecision[], message: string, target: string,
  outcome?: StaticMcpSummary["outcome"]): StaticMcpSummary => {
  const counts = { added: 0, updated: 0, matched: 0, preserved: 0, rejected: 0 };
  decisions.forEach(decision => { counts[decision.action] += 1; });
  const rejected = counts.rejected > 0;
  const next = rejected ? "Resolve rejected entries in the source/native configuration; run mcp status, then retry. No credential values are shown."
      : action === "migrate" ? "Review modeck-mcp.yaml, then run mcp apply with the same explicit agent and scope. Native source was preserved."
        : action === "status" ? "Run mcp apply with the same options to apply these planned changes. Counts describe the plan."
          : "Verify with the agent's native MCP list command; restart sessions to load changes. Policy, authentication and connectivity remain agent responsibilities.";
  return { action, agent: request.agent, scope: request.scope, outcome: outcome ?? (rejected ? action === "migrate" && (counts.added || counts.matched) ? "partial" : "failed" : "success"), counts, decisions, message,
    target, configuration: join(request.configRoot, "modeck-mcp.yaml"),
    next: request.agent === "codex" ? `${next} Only the default user file is managed; native visibility is covered only without --profile or -c/--config overrides. Independent profiles and CLI overrides are not synchronized.` : next };
};
const label = (name: string, index: number): string => serverName(name) ? name : `[native entry ${index + 1}]`;
export const manageStaticMcp = async (action: "migrate" | "apply" | "status" | "recover", request: StaticMcpRequest): Promise<StaticMcpSummary> => {
  await checkDirectory(request.targetHome); await checkDirectory(request.cwd); await checkDirectory(request.configRoot);
  for (const path of [request.targetHome, request.cwd, request.configRoot]) {
    if (!(await lstat(path)).isDirectory()) throw modeError("E_PATH", "MCP home, working directory and configuration directory must already exist");
  }
  const central = join(request.configRoot, "modeck-mcp.yaml");
  const location = await locate(request, action !== "recover");
  if (action === "recover") return summary(action, request, [], await recover(request, central, location.path), location.path);
  await assertNoJournal(request, location.path);
  const state = ownershipPath(request.targetHome, location.path);
  const observations = await observe([central, state, ...location.checks, ...location.policy,
    ...(location.shadowedCandidate ? [location.shadowedCandidate] : [])]);
  const imageAt = (path: string): FileImage | null => observations.find(item => item.path === path)?.image ?? null;
  for (const item of observations) await safeNative(item.path, item.image);
  const sourceImage = imageAt(central);
  if (action !== "migrate" && !sourceImage) throw modeError("E_CONFIG", "Static MCP configuration modeck-mcp.yaml is missing; migrate first or create the static configuration");
  const config = parseCentral(sourceImage);
  const nativeImage = imageAt(location.path);
  const root = nativeRoot(request.agent, nativeImage);
  const current = nativeServers(root, location.key);
  const owned = await readOwned(imageAt(state), request, location.path, central);
  const decisions: StaticMcpDecision[] = [];
  const verify = async (written: readonly Change[] = []): Promise<void> => {
    await verifyObserved(observations, written);
    if (canonical(await locate(request)) !== canonical(location)) throw modeError("E_PLAN_STALE", "MCP scope topology changed before writing");
  };
  if (action === "migrate") {
    const imported: Record<string, StaticMcpServer> = {};
    const enrolled: Record<string, Owned> = { ...owned.servers };
    Object.entries(current).forEach(([name, raw], index) => {
      try {
        if (!serverName(name) || request.agent === "claude" && ["workspace", "claude-in-chrome", "computer-use"].includes(name)) throw modeError("E_CONFIG", "Native server name is outside the migration contract");
        const previous = Object.hasOwn(owned.servers, name) ? owned.servers[name] : undefined;
        if (previous && (hash(raw) !== previous.digest || endpoint(raw) !== previous.endpoint && !legacyEndpoints(raw).includes(previous.endpoint))) {
          throw modeError("E_CONFIG", "Owned native definition drifted or changed endpoint; migrate cannot reset its ownership baseline. Restore it or use a new server name");
        }
        const server = decodeServer(request.agent, raw, true);
        const encoded = encodeServer(request.agent, server);
        if (canonical(encoded) !== canonical(raw)) throw modeError("E_CONFIG", "Native definition cannot be represented without loss; native source preserved");
        if (Object.hasOwn(config.servers, name)) {
          const existing = config.servers[name]!;
          const alreadyNative = canonical(existing) === canonical(server);
          let portableMatch = false;
          if (!alreadyNative && existing.transport !== "native") {
            try { portableMatch = equivalent(request.agent, raw, encodeServer(request.agent, existing)); } catch { portableMatch = false; }
          }
          if (!alreadyNative && !portableMatch) {
            decisions.push({ name, action: "rejected", reason: "Central name is already occupied by a different definition; both definitions were preserved" });
            return;
          }
          if (portableMatch) imported[name] = server;
          decisions.push({ name, action: "matched", reason: previous ? "Central definition matches; ownership verified and native bytes preserved"
            : portableMatch ? "Legacy portable definition matches the native adapter; upgraded to a lossless agent-specific definition and enrolled without changing native bytes"
              : "Central definition matches; explicit migration enrolled the source for management without changing native bytes" });
        } else {
          imported[name] = server;
          decisions.push({ name, action: "added", reason: "Imported a losslessly representable definition and enrolled its native source for management; native bytes preserved" });
        }
        // Hash the exact native entry, including known empty/default fields, rather than its rendered form.
        if (!previous) enrolled[name] = { digest: hash(raw), endpoint: endpoint(raw) };
      } catch (error) {
        decisions.push({ name: label(name, index), action: "rejected", reason: error instanceof Error && "code" in error && error.code === "E_CONFIG" ? error.message : "Definition cannot be migrated safely; native source preserved" });
      }
    });
    Object.keys(owned.servers).filter(name => !Object.hasOwn(current, name)).forEach(name => decisions.push({ name, action: "rejected",
      reason: "Owned native definition was removed; migrate cannot reset its ownership baseline. Restore it before migrating" }));
    Object.keys(config.servers).filter(name => !Object.hasOwn(current, name) && !Object.hasOwn(owned.servers, name))
      .forEach(name => decisions.push({ name, action: "preserved", reason: "Existing central definition preserved" }));
    const desired: StaticMcpConfig = checkedConfig({ schemaVersion: 1, servers: { ...config.servers, ...imported } });
    const nextOwned: Ownership = { ...owned, servers: enrolled };
    // Native definitions may contain literal credentials; keep this file private, including when tightening an existing file.
    const changes: Change[] = Object.keys(imported).length ? [{ path: central, before: sourceImage, after: centralImage(desired, 0o600) }] : [];
    if (canonical(nextOwned) !== canonical(owned)) changes.push({ path: state, before: imageAt(state), after: jsonImage(nextOwned) });
    await transact(request, central, location.path, changes, verify);
    return summary(action, request, decisions, changes.length ? "Safe entries migrated/enrolled for management; native source unchanged"
      : "No central or ownership changes; native source unchanged", location.path);
  }
  const desired: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    try {
      if (request.agent === "claude" && ["workspace", "claude-in-chrome", "computer-use"].includes(name)) throw modeError("E_CONFIG", "Server name is reserved by the native agent");
      desired[name] = encodeServer(request.agent, server);
    } catch (error) {
      decisions.push({ name, action: "rejected", reason: error instanceof Error && "code" in error && error.code === "E_CONFIG" ? error.message : "Definition cannot be represented by this agent" });
    }
  }
  if (!nativeImage && location.shadowedCandidate && imageAt(location.shadowedCandidate)) {
    for (const name of Object.keys(desired)) decisions.push({ name, action: "rejected",
      reason: "Creating .mcp.json would hide CodeBuddy's existing project mcp.json candidate; use Claude user scope or reconcile the native layout explicitly" });
  }
  // Other active native scopes can shadow the destination. Preserve all of them and reject collisions.
  const competing: Readonly<Record<string, unknown>>[] = [];
  for (const path of location.checks) {
    const other = nativeRoot(request.agent, imageAt(path));
    if (path !== location.path) competing.push(nativeServers(other, location.key));
    if (request.agent === "claude" && Object.hasOwn(other, "projects")) {
      const projects = object(other.projects);
      if (Object.hasOwn(projects, request.cwd)) competing.push(nativeServers(object(projects[request.cwd]), location.key));
    }
  }
  const updates: Record<string, unknown> = {};
  const nextOwned: Record<string, Owned> = { ...owned.servers };
  for (const name of [...new Set([...Object.keys(current), ...Object.keys(owned.servers), ...Object.keys(desired)])].sort()) {
    if (decisions.some(decision => decision.name === name && decision.action === "rejected")) continue;
    const previous = Object.hasOwn(owned.servers, name) ? owned.servers[name] : undefined;
    const present = Object.hasOwn(current, name) ? current[name] : undefined;
    const next = Object.hasOwn(desired, name) ? desired[name] : undefined;
    if (next === undefined) {
      decisions.push({ name: serverName(name) ? name : "[unmanaged entry]", action: "preserved", reason: "Not selected centrally; native definition retained without deletion" });
      continue;
    }
    if (previous && (present === undefined || hash(present) !== previous.digest)) {
      decisions.push({ name, action: "rejected", reason: "Owned native definition drifted or was removed; refusing to overwrite. Restore the original native definition or choose a new server name" });
      continue;
    }
    const endpointBaseline = previous && present !== undefined && hash(present) === previous.digest
      && legacyEndpoints(present).includes(previous.endpoint) ? endpoint(present) : previous?.endpoint;
    if (previous && endpoint(next) !== endpointBaseline) {
      decisions.push({ name, action: "rejected", reason: "Owned endpoint identity changed; use a new server name to keep native credentials isolated" });
      continue;
    }
    if (competing.some(map => Object.hasOwn(map, name) && !equivalent(request.agent, map[name], next))) {
      decisions.push({ name, action: "rejected", reason: "Another native project/local/profile scope defines this name differently; resolve the native scope conflict first" });
      continue;
    }
    const exactMatch = present !== undefined && canonical(present) === canonical(next);
    const portableMatch = present !== undefined && config.servers[name]?.transport !== "native" && equivalent(request.agent, present, next);
    if (exactMatch || portableMatch) {
      decisions.push({ name, action: "matched", reason: previous ? "Managed definition already matches" : "Existing unmanaged definition already matches; ownership was not adopted" });
    } else if (!previous && present !== undefined) {
      decisions.push({ name, action: "rejected", reason: "Unmanaged native name is occupied by a different definition; preserve it or choose a new central name" });
    } else {
      updates[name] = next;
      nextOwned[name] = { digest: hash(next), endpoint: endpoint(next) };
      decisions.push({ name, action: present === undefined ? "added" : "updated", reason: present === undefined ? "New managed native definition" : "Managed definition updated after drift and endpoint checks" });
    }
  }
  await verify();
  if (decisions.some(decision => decision.action === "rejected")) {
    // A cancelled addition is not a preserved native server: count every blocked write as rejected.
    const refused = decisions.map(decision => ["added", "updated"].includes(decision.action)
      ? { ...decision, action: "rejected" as const, reason: "Atomic batch refused because another entry was rejected; no native changes made" } : decision);
    return summary(action, request, refused, "Conflicts found; no native or ownership changes made", location.path, "failed");
  }
  if (action === "apply" && Object.keys(updates).length) {
    const merged = mergeImage(request.agent, nativeImage, updates);
    const includesNative = Object.keys(updates).some(name => config.servers[name]?.transport === "native");
    // Native MCP definitions may contain literal credentials; do not add them to a broadly readable file.
    const nextNative = includesNative ? { ...merged, mode: 0o600 } : merged;
    const nextState = jsonImage({ ...owned, servers: nextOwned });
    await transact(request, central, location.path, [
      { path: location.path, before: nativeImage, after: nextNative },
      { path: state, before: imageAt(state), after: nextState },
    ], verify);
  }
  return summary(action, request, decisions, action === "status" ? "Static MCP plan inspected; no changes made"
    : Object.keys(updates).length ? "Static MCP configuration applied incrementally" : "Already matches; no changes made", location.path);
};
