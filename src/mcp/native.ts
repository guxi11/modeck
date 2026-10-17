import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { canonical, modeError, parseJson } from "../contracts/index.js";
import type { FileImage } from "../contracts/index.js";
import type { StaticMcpAgent, StaticMcpRequest, StaticMcpServer } from "../contracts/mcp-static.js";
import { data, missing, object, readImage, safeAbsolute } from "../integration/fs.js";
import { checkedServer, fail } from "./config.js";

const ancestors = (path: string): readonly string[] => dirname(path) === path ? [path] : [path, ...ancestors(dirname(path))];
export type NativeLocation = Readonly<{ path: string; key: string; checks: readonly string[]; policy: readonly string[];
  shadowedCandidate: string | null }>;
export const locate = async (request: StaticMcpRequest, checkPolicy = true): Promise<NativeLocation> => {
  const { agent, scope } = request;
  if (agent === "codex" && scope !== "user") throw modeError("E_USAGE", "Codex project writes are outside this implementation; use explicit --scope user. Native project/profile capabilities remain agent responsibilities");
  const home = await safeAbsolute(request.targetHome);
  const cwd = await safeAbsolute(request.cwd);
  const configDir = join(home, agent === "claude" ? ".claude" : ".codex");
  await safeAbsolute(configDir);
  const configured = process.env[agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"];
  if (configured !== undefined && configured !== configDir) throw modeError("E_CONFIG", "Alternate agent configuration directories are not supported; unset the agent configuration directory override");
  // Claude relocates its user/local store whenever CLAUDE_CONFIG_DIR is set, including its default value.
  const user = agent === "claude" ? join(configured === undefined ? home : configDir, ".claude.json") : join(configDir, "config.toml");
  const project = join(cwd, agent === "claude" ? ".mcp.json" : ".codex/config.toml");
  // Current Codex uses independent <name>.config.toml profiles, not legacy [profiles.name] tables.
  const profileNames = agent === "codex" && checkPolicy
    ? (await readdir(configDir).catch(error => { if (missing(error)) return []; throw error; })).filter(name => name.endsWith(".config.toml")).sort() : [];
  if (profileNames.length > 512) throw modeError("E_LIMIT", "Too many native Codex profiles to inspect safely");
  const system = agent === "claude" ? process.platform === "darwin" ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code"
    : process.platform === "darwin" ? "/private/etc/codex" : "/etc/codex";
  const settings = agent === "claude" ? [join(configDir, "settings.json"), join(cwd, ".claude/settings.json"), join(cwd, ".claude/settings.local.json")] : [];
  const policy = agent === "claude" ? [join(system, "managed-mcp.json"), join(system, "managed-settings.json"), join(configDir, "managed-mcp.json"), join(configDir, "managed-settings.json"), ...settings]
    : [join(system, "requirements.toml"), join(system, "managed_config.toml"), join(system, "config.toml"), join(configDir, "requirements.toml")];
  const fragments = agent === "claude" ? [join(system, "managed-settings.d"), join(configDir, "managed-settings.d")] : [];
  for (const directory of checkPolicy ? fragments : []) {
    await safeAbsolute(directory);
    const names = await readdir(directory).catch(error => { if (missing(error)) return []; throw error; });
    if (names.length) fail("Managed policy fragments require native administration; MCP writes refused");
  }
  const policyImages = await Promise.all((checkPolicy ? policy : []).map(async path => ({ path, image: await readImage(path) })));
  for (const { path, image } of policyImages) {
    if (!image) continue;
    if (settings.includes(path)) {
      const root = nativeRoot("claude", image);
      if (["allowedMcpServers", "deniedMcpServers", "allowManagedMcpServersOnly", "managedMcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers", "enableAllProjectMcpServers"].some(key => Object.hasOwn(root, key))) {
        fail("MCP policy/approval settings require native inspection; MCP writes refused");
      }
    } else fail("Managed agent policy requires native administration; MCP writes refused");
  }
  return { path: scope === "user" ? user : project, key: agent === "claude" ? "mcpServers" : "mcp_servers",
    checks: [...new Set(agent === "claude" ? [user, project] : [user, ...ancestors(cwd).map(root => join(root, ".codex/config.toml")),
      ...profileNames.map(name => join(configDir, name))])], policy,
    shadowedCandidate: agent === "claude" && scope === "project" ? join(cwd, "mcp.json") : null };
};

export const nativeRoot = (agent: StaticMcpAgent, image: FileImage | null): Record<string, unknown> => {
  if (!image) return {};
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(data(image));
    if (source.includes("GENERATED by evoloop")) fail("A generator owns the MCP target");
    const root = object(agent === "codex" ? parseToml(source) : parseJson(source));
    canonical(root);
    return root;
  } catch { return fail("Cannot safely parse native configuration; inspect it with the agent's native tools"); }
};
export const nativeServers = (root: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> =>
  Object.hasOwn(root, key) ? object(root[key]) : {};
const exactFields = (server: Record<string, unknown>, allowed: readonly string[]): void => {
  if (Object.keys(server).some(key => !allowed.includes(key))) fail("Native definition contains fields that cannot be migrated without loss");
};
const importedRefs = (raw: unknown): Record<string, { env: string }> => Object.fromEntries(Object.entries(object(raw)).map(([key, value]) => {
  if (typeof value !== "string") fail("Native credential fields must be pure environment references");
  const match = /^\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/u.exec(value as string);
  if (!match) fail("Literal or composite credentials are preserved only in native configuration; use pure environment references before migrating");
  return [key, { env: match![1]! }];
}));
const assertClaudeRemoteReferences = (server: StaticMcpServer): void => {
  if (server.transport === "stdio") return;
  const blocked = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "NPM_TOKEN", "HTTPS_PROXY"];
  if (Object.values(server.headers ?? {}).some(ref => blocked.includes(ref.env))) {
    fail("Claude reads this credential reference as empty in remote headers; use a dedicated variable name and verify authentication natively");
  }
};
export const decodeServer = (agent: StaticMcpAgent, raw: unknown, migration = false): StaticMcpServer => {
  const value = object(raw);
  if (agent === "claude") {
    const transport = value.type ?? (Object.hasOwn(value, "command") ? "stdio" : undefined);
    if (transport === "stdio") {
      exactFields(value, ["type", "command", "args", "env"]);
      const server = checkedServer({ transport, command: value.command,
        ...(value.args !== undefined ? { args: value.args } : {}),
        ...(value.env !== undefined ? { env: importedRefs(value.env) } : {}) });
      if (migration && server.transport === "stdio" && !/^[a-zA-Z0-9_./@+:-]+$/u.test(server.command)) fail("Command text may contain credentials or shell syntax; review and configure it centrally");
      if (migration && server.transport === "stdio" && server.args?.length) fail("Arguments may contain credentials; migrate only argument-free definitions, then configure reviewed arguments centrally");
      return server;
    }
    if (transport !== "http" && transport !== "sse") return fail("Native transport is outside the supported migration contract");
    exactFields(value, ["type", "url", "headers"]);
    const server = checkedServer({ transport, url: value.url,
      ...(value.headers !== undefined ? { headers: importedRefs(value.headers) } : {}) });
    assertClaudeRemoteReferences(server);
    if (migration && server.transport !== "stdio" && !["", "/", "/mcp", "/sse"].includes(new URL(server.url).pathname)) fail("URL path may contain credentials; review and configure this endpoint centrally");
    return server;
  }
  if (Object.hasOwn(value, "command")) {
    exactFields(value, ["command", "args", "env_vars"]);
    if (value.env_vars !== undefined && (!Array.isArray(value.env_vars) || value.env_vars.some(item => typeof item !== "string")
      || new Set(value.env_vars).size !== value.env_vars.length)) fail("Invalid native environment allowlist");
    const server = checkedServer({ transport: "stdio", command: value.command,
      ...(value.args !== undefined ? { args: value.args } : {}),
      ...(Array.isArray(value.env_vars) ? { env: Object.fromEntries(value.env_vars.map(name => [name, { env: name }])) } : {}) });
    if (migration && server.transport === "stdio" && !/^[a-zA-Z0-9_./@+:-]+$/u.test(server.command)) fail("Command text may contain credentials or shell syntax; review and configure it centrally");
    if (migration && server.transport === "stdio" && server.args?.length) fail("Arguments may contain credentials; migrate only argument-free definitions, then configure reviewed arguments centrally");
    return server;
  }
  exactFields(value, ["url", "env_http_headers", "bearer_token_env_var"]);
  const headers = value.env_http_headers === undefined ? {} : Object.fromEntries(Object.entries(object(value.env_http_headers)).map(([key, ref]) => [key, { env: ref }]));
  // bearer_token_env_var adds a Bearer prefix, which a pure-reference header cannot represent losslessly.
  if (value.bearer_token_env_var !== undefined) fail("Native bearer-token authentication cannot be migrated losslessly into pure-reference headers; keep it native");
  const server = checkedServer({ transport: "http", url: value.url, ...(Object.keys(headers).length ? { headers } : {}) });
  if (migration && server.transport !== "stdio" && !["", "/", "/mcp", "/sse"].includes(new URL(server.url).pathname)) fail("URL path may contain credentials; review and configure this endpoint centrally");
  return server;
};
export const encodeServer = (agent: StaticMcpAgent, server: StaticMcpServer): Readonly<Record<string, unknown>> => {
  if (agent === "claude") assertClaudeRemoteReferences(server);
  if (agent === "claude") return server.transport === "stdio"
    ? { type: "stdio", command: server.command, ...(server.args?.length ? { args: server.args } : {}),
      ...(server.env ? { env: Object.fromEntries(Object.entries(server.env).map(([key, ref]) => [key, `\${${ref.env}}`])) } : {}) }
    : { type: server.transport, url: server.url,
      ...(server.headers ? { headers: Object.fromEntries(Object.entries(server.headers).map(([key, ref]) => [key, `\${${ref.env}}`])) } : {}) };
  if (server.transport === "sse") return fail("Codex explicit SSE transport is unsupported by this adapter; keep the server native or use a verified HTTP endpoint");
  if (server.transport === "stdio") {
    if (Object.entries(server.env ?? {}).some(([key, ref]) => key !== ref.env)) fail("Codex environment allowlists cannot rename environment variables without materializing credentials");
    return { command: server.command, ...(server.args?.length ? { args: server.args } : {}),
      ...(Object.keys(server.env ?? {}).length ? { env_vars: Object.values(server.env!).map(ref => ref.env) } : {}) };
  }
  return { url: server.url, ...(Object.keys(server.headers ?? {}).length ? { env_http_headers: Object.fromEntries(Object.entries(server.headers!).map(([key, ref]) => [key, ref.env])) } : {}) };
};
export const equivalent = (agent: StaticMcpAgent, left: unknown, right: unknown): boolean => {
  if (canonical(left) === canonical(right)) return true;
  try { return canonical(decodeServer(agent, left)) === canonical(decodeServer(agent, right)); } catch { return false; }
};

type Section = { start: number; end: number; path: readonly string[] };
const tablePath = (line: string): readonly string[] => {
  const result: string[] = [];
  let node: unknown = parseToml(`${line}\n`);
  while (node && typeof node === "object" && !Array.isArray(node)) {
    const entries = Object.entries(node);
    if (entries.length !== 1) break;
    result.push(entries[0]![0]); node = entries[0]![1];
  }
  return result;
};
const tomlSections = (source: string): readonly Section[] => {
  const starts: { start: number; path: readonly string[] }[] = [];
  let quote = ""; let triple = false; let escaped = false; let comment = false; let depth = 0; let lineStart = true;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (comment) { if (char === "\n") { comment = false; lineStart = true; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (quote === '"' && char === "\\") { escaped = true; continue; }
      if (triple && source.slice(index, index + 3) === quote.repeat(3)) { index += 2; quote = ""; triple = false; }
      else if (!triple && char === quote) quote = "";
      continue;
    }
    if (char === "\n") { lineStart = true; continue; }
    if (lineStart && /[ \t\r]/u.test(char)) continue;
    if (lineStart && depth === 0 && char === "[") {
      const end = source.indexOf("\n", index);
      const line = source.slice(index, end < 0 ? undefined : end);
      starts.push({ start: index, path: tablePath(line) });
    }
    lineStart = false;
    if (char === "#") { comment = true; continue; }
    if (char === '"' || char === "'") {
      quote = char; triple = source.slice(index, index + 3) === char.repeat(3);
      if (triple) index += 2;
    } else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
  }
  return starts.map((section, index) => ({ ...section, end: starts[index + 1]?.start ?? source.length }));
};
export const mergeImage = (agent: StaticMcpAgent, before: FileImage | null, changes: Readonly<Record<string, unknown>>): FileImage => {
  const root = nativeRoot(agent, before);
  const key = agent === "claude" ? "mcpServers" : "mcp_servers";
  const desired = { ...root, [key]: { ...nativeServers(root, key), ...changes } };
  const source = before ? data(before).toString("utf8") : agent === "claude" ? "{}\n" : "";
  let result: string;
  if (agent === "claude") {
    result = Object.entries(changes).reduce((previous, [name, value]) => applyEdits(previous,
      modify(previous, [key, name], value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes("\r\n") ? "\r\n" : "\n" } })), source);
  } else {
    const sections = tomlSections(source);
    const replaced = sections.filter(section => section.path[0] === key && section.path[1] !== undefined && Object.hasOwn(changes, section.path[1]));
    const untouched = [...replaced].sort((a, b) => b.start - a.start).reduce((previous, section) => previous.slice(0, section.start) + previous.slice(section.end), source);
    result = `${untouched}${untouched.endsWith("\n") || !untouched ? "" : "\n"}\n${stringifyToml({ [key]: changes })}`;
  }
  const image: FileImage = { data: result, encoding: "utf8", mode: before?.mode ?? 0o600 };
  if (canonical(nativeRoot(agent, image)) !== canonical(desired)) fail("Native file layout cannot be changed without losing unrelated configuration; write refused");
  return image;
};
