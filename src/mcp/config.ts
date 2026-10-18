import { parseDocument, stringify } from "yaml";
import { canonical, modeError } from "../contracts/index.js";
import type { FileImage } from "../contracts/index.js";
import type { StaticMcpConfig, StaticMcpReference, StaticMcpServer } from "../contracts/mcp-static.js";
import { data, object } from "../integration/fs.js";

export const fail = (message: string): never => { throw modeError("E_CONFIG", message); };
export const serverName = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(value)
  && !["__proto__", "prototype", "constructor"].includes(value);
const keys = (value: Record<string, unknown>, permitted: readonly string[], required: readonly string[] = []): void => {
  if (Object.keys(value).some(key => !permitted.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail("Unsupported or missing MCP configuration field");
};
const text = (value: unknown, maximum = 4096): string => {
  if (typeof value !== "string" || !value || value.length > maximum || /\p{Cc}/u.test(value)) fail("Invalid MCP string");
  return value as string;
};
export const references = (value: unknown): Readonly<Record<string, StaticMcpReference>> => {
  const entries = Object.entries(object(value));
  if (entries.length > 128) fail("Too many MCP references");
  return Object.fromEntries(entries.map(([key, raw]) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$/u.test(key)) fail("Invalid MCP environment or header name");
    const ref = object(raw);
    keys(ref, ["env"], ["env"]);
    if (typeof ref.env !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/u.test(ref.env)) fail("MCP credentials must use a pure environment reference");
    return [key, { env: ref.env as string }];
  }));
};
export const checkedServer = (value: unknown): StaticMcpServer => {
  const server = object(value);
  if (server.transport === "native") {
    keys(server, ["transport", "agent", "definition"], ["transport", "agent", "definition"]);
    if (server.agent !== "claude" && server.agent !== "codex") fail("Invalid native MCP agent");
    const agent = server.agent as "claude" | "codex";
    const definition = object(server.definition);
    const check = (item: unknown, depth: number): void => {
      if (depth > 16) fail("Native MCP definition is too deeply nested");
      if (typeof item === "string") { if (item.length > 16_384) fail("Native MCP string is too long"); return; }
      if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return;
      if (Array.isArray(item)) {
        if (item.length > 512) fail("Native MCP array is too large");
        item.forEach(child => check(child, depth + 1)); return;
      }
      if (item && typeof item === "object") {
        const entries = Object.entries(item);
        if (entries.length > 512) fail("Native MCP object is too large");
        entries.forEach(([key, child]) => { if (key.length > 256) fail("Native MCP field name is too long"); check(child, depth + 1); });
        return;
      }
      fail("Native MCP definition must contain only finite JSON values");
    };
    canonical(definition);
    check(definition, 0);
    const strings = (key: string): void => {
      const value = definition[key];
      if (value !== undefined && typeof value !== "string") fail(`Invalid native MCP ${key} field`);
      if (["command", "url", "transport", "type", "cwd"].includes(key) && value === "") fail(`Invalid native MCP ${key} field`);
    };
    const stringList = (key: string): void => {
      const value = definition[key];
      if (value !== undefined && (!Array.isArray(value) || value.length > 512 || value.some(item => typeof item !== "string"))) fail(`Invalid native MCP ${key} field`);
    };
    const envVars = definition.env_vars;
    if (envVars !== undefined && (!Array.isArray(envVars) || envVars.length > 512 || envVars.some(item => {
      if (typeof item === "string") return false;
      const entry = object(item);
      return typeof entry.name !== "string" || !entry.name
        || entry.source !== undefined && entry.source !== "local" && entry.source !== "remote";
    }))) fail("Invalid native MCP env_vars field");
    const stringMap = (key: string): void => {
      const value = definition[key];
      if (value !== undefined && Object.values(object(value)).some(item => typeof item !== "string")) fail(`Invalid native MCP ${key} field`);
    };
    for (const key of ["command", "url", "transport", "type", "cwd", "bearer_token_env_var"]) strings(key);
    stringList("args");
    for (const key of ["env", "headers", "http_headers", "env_http_headers"]) stringMap(key);
    for (const key of ["disabled", "enabled", "required"]) {
      if (definition[key] !== undefined && typeof definition[key] !== "boolean") fail(`Invalid native MCP ${key} field`);
    }
    for (const key of ["timeout", "startup_timeout_sec", "tool_timeout_sec"]) {
      if (definition[key] !== undefined && (typeof definition[key] !== "number" || !Number.isFinite(definition[key]))) fail(`Invalid native MCP ${key} field`);
    }
    if (agent === "claude") {
      if (definition.type !== undefined && !["stdio", "http", "sse"].includes(String(definition.type))) fail("Unsupported Claude MCP transport");
      const type = definition.type ?? (Object.hasOwn(definition, "command") ? "stdio" : "http");
      if (type === "stdio" && typeof definition.command !== "string" || type !== "stdio" && typeof definition.url !== "string") fail("Native Claude MCP definition is missing its transport endpoint");
    } else if (typeof definition.command !== "string" && typeof definition.url !== "string") {
      fail("Native Codex MCP definition requires command or url");
    }
    // Validate the preserved core shape; the native agent remains authoritative for its full schema and authentication.
    return { transport: "native", agent, definition };
  }
  if (server.transport === "stdio") {
    keys(server, ["transport", "command", "args", "env"], ["transport", "command"]);
    const command = text(server.command);
    if (server.args !== undefined && (!Array.isArray(server.args) || server.args.length > 256
      || server.args.some(arg => typeof arg !== "string" || arg.length > 4096 || /\p{Cc}/u.test(arg)))) fail("Invalid MCP argument list");
    return { transport: "stdio", command,
      ...(Array.isArray(server.args) && server.args.length ? { args: server.args as string[] } : {}),
      ...(server.env !== undefined && Object.keys(object(server.env)).length ? { env: references(server.env) } : {}) };
  }
  if (server.transport !== "http" && server.transport !== "sse") return fail("Unsupported MCP transport");
  keys(server, ["transport", "url", "headers"], ["transport", "url"]);
  const url = text(server.url, 2048);
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash
      || /\$\{|%24%7b/iu.test(url)) fail("MCP URLs must not contain credentials, queries, fragments or interpolation");
  } catch { return fail("MCP URLs must not contain credentials, queries, fragments or interpolation"); }
  return { transport: server.transport, url,
    ...(server.headers !== undefined && Object.keys(object(server.headers)).length ? { headers: references(server.headers) } : {}) };
};
export const checkedConfig = (value: unknown): StaticMcpConfig => {
  canonical(value);
  const config = object(value);
  keys(config, ["schemaVersion", "servers"], ["schemaVersion", "servers"]);
  if (config.schemaVersion !== 1) fail("Unsupported static MCP schema version");
  const entries = Object.entries(object(config.servers));
  if (entries.length > 512) fail("Too many MCP servers");
  return { schemaVersion: 1, servers: Object.fromEntries(entries.map(([name, server]) => {
    if (!serverName(name)) fail("Invalid MCP server name");
    return [name, checkedServer(server)];
  })) };
};
export const parseCentral = (image: FileImage | null): StaticMcpConfig => {
  if (!image) return { schemaVersion: 1, servers: {} };
  try {
    const document = parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(data(image)), {
      schema: "core", uniqueKeys: true, strict: true,
    });
    if (document.errors.length || document.warnings.length) fail("Invalid static MCP YAML");
    return checkedConfig(document.toJS({ maxAliasCount: 0 }));
  } catch { return fail("Invalid static MCP configuration; inspect modeck-mcp.yaml without exposing its values"); }
};
export const centralImage = (config: StaticMcpConfig, mode = 0o600): FileImage => ({
  data: stringify(config), encoding: "utf8", mode,
});
