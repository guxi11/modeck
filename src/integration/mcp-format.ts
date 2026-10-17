import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { agentDefinitions, canonical, isAgent, isMcpAgent, modeError } from "../contracts/index.js";
import type { Agent, McpAgent, McpEnvRef, McpServer, McpServers } from "../contracts/index.js";
import { parseConfig } from "../core/validation.js";
import { data, imageJson, object, readImage } from "./fs.js";

export type { McpServers } from "../contracts/index.js";
const fail = (message: string): never => { throw modeError("E_CONFIG", message); };
const refs = (server: McpServer): Readonly<Record<string, McpEnvRef>> => server.transport === "stdio" ? server.env ?? {} : server.headers ?? {};

const checkedServers = (servers: McpServers): McpServers => {
  // Public native APIs enforce the same contract as YAML loading before returning a plan.
  const config = parseConfig({ resources: {}, modes: {}, mcp: { servers } });
  Object.values(config.mcp.servers).flatMap(server => Object.values(refs(server))).forEach(ref => {
    if (ref.required !== false && (!Object.hasOwn(process.env, ref.env) || !process.env[ref.env])) fail("Required MCP environment reference is missing");
  });
  return config.mcp.servers;
};

export const validateMcpEnvironment = (servers: McpServers): void => { checkedServers(servers); };

const entries = (server: McpServer): readonly (readonly [string, McpEnvRef])[] => Object.entries(refs(server))
  .filter(([, ref]) => ref.required !== false || Object.hasOwn(process.env, ref.env) && Boolean(process.env[ref.env]));
const expectedServer = (agent: McpAgent, server: McpServer): Record<string, unknown> => {
  if (agent === "codebuddy" && Object.values(refs(server)).some(ref => !/^[A-Z_][A-Z0-9_]*$/u.test(ref.env))) {
    fail("CodeBuddy environment references require uppercase names");
  }
  const values = entries(server);
  const environment = (reference: (name: string) => string): Record<string, string> =>
    Object.fromEntries(values.map(([key, ref]) => [key, reference(ref.env)]));
  if (agent === "cursor" || agent === "copilot" || agent === "opencode") {
    // These render-only targets have no verified mapping for explicit SSE selection.
    if (server.transport === "sse") fail("This MCP render target does not support explicit SSE transport");
    if (agent === "opencode") {
      return server.transport === "stdio"
        ? { type: "local", command: [server.command, ...server.args ?? []], enabled: true,
          ...(values.length ? { environment: environment(name => `{env:${name}}`) } : {}) }
        : { type: "remote", url: server.url, enabled: true,
          ...(values.length ? { headers: environment(name => `{env:${name}}`) } : {}) };
    }
    return server.transport === "stdio"
      ? { ...(agent === "copilot" ? { type: "stdio" } : {}), command: server.command,
        ...(server.args?.length ? { args: server.args } : {}),
        ...(values.length ? { env: environment(name => `\${env:${name}}`) } : {}) }
      : { ...(agent === "copilot" ? { type: "http" } : {}), url: server.url,
        ...(values.length ? { headers: environment(name => `\${env:${name}}`) } : {}) };
  }
  if (agent === "codex") {
    if (server.transport === "sse") fail("Codex does not support an explicit SSE transport");
    if (server.transport === "stdio") {
      if (values.some(([key, ref]) => key !== ref.env)) fail("Codex cannot rename environment references without materializing credentials");
      return { command: server.command, ...(server.args?.length ? { args: server.args } : {}),
        ...(values.length ? { env_vars: values.map(([, ref]) => ref.env) } : {}) };
    }
    return { url: server.url, ...(values.length ? { env_http_headers: Object.fromEntries(values.map(([key, ref]) => [key, ref.env])) } : {}) };
  }
  return server.transport === "stdio"
    ? { type: "stdio", command: server.command, ...(server.args?.length ? { args: server.args } : {}),
      ...(values.length ? { env: Object.fromEntries(values.map(([key, ref]) => [key, `\${${ref.env}}`])) } : {}) }
    : { type: server.transport, url: server.url,
      ...(values.length ? { headers: Object.fromEntries(values.map(([key, ref]) => [key, `\${${ref.env}}`])) } : {}) };
};

const definitions = (agent: McpAgent, servers: McpServers): Record<string, unknown> =>
  Object.fromEntries(Object.entries(servers).map(([name, server]) => {
    if (agent === "claude" && ["workspace", "claude-in-chrome", "computer-use"].includes(name)) {
      fail("MCP server name is reserved by Claude Code");
    }
    return [name, expectedServer(agent, server)];
  }));

export const nativeMcpDefinitions = (agent: Agent, servers: McpServers): Readonly<Record<string, unknown>> => {
  if (!isAgent(agent)) fail("Unsupported MCP agent");
  return definitions(agent, checkedServers(servers));
};

const renderTargets = {
  cursor: { rulesyncTarget: "cursor", path: ".cursor/mcp.json", key: "mcpServers" },
  copilot: { rulesyncTarget: "copilot", path: ".vscode/mcp.json", key: "servers" },
  opencode: { rulesyncTarget: "opencode", path: "opencode.jsonc", key: "mcp" },
} as const;

export const renderMcpServers = async (agent: McpAgent, servers: McpServers): Promise<Readonly<Record<string, unknown>>> => {
  if (!isMcpAgent(agent)) fail("Unsupported MCP agent");
  const normalized = checkedServers(servers);
  const expected = definitions(agent, normalized);
  if (!Object.keys(normalized).length) return expected;
  const sourceServers = agent === "codex" ? Object.fromEntries(Object.entries(normalized).map(([name, server]) => [name,
    server.transport === "stdio" ? { type: "stdio", command: server.command,
      ...(server.args?.length ? { args: server.args } : {}), ...(entries(server).length ? { envVars: entries(server).map(([, ref]) => ref.env) } : {}) }
      : expectedServer("claude", server)]))
    : agent === "copilot" ? expected
      : Object.fromEntries(Object.entries(normalized).map(([name, server]) => {
        const definition = expectedServer("claude", server);
        // Cursor infers transport from command/url; avoid forwarding an unverified native type field.
        if (agent === "cursor") { const { type: _type, ...fields } = definition; return [name, fields]; }
        return [name, definition];
      }));
  const target = isAgent(agent) ? { rulesyncTarget: agentDefinitions[agent].rulesyncTarget,
    path: agent === "codex" ? ".codex/config.toml" : ".mcp.json", key: agent === "codex" ? "mcp_servers" : "mcpServers" }
    : renderTargets[agent];
  const temporary = await mkdtemp(join(await realpath(tmpdir()), "modeck-mcp-format-"));
  try {
    await mkdir(join(temporary, ".rulesync"));
    await mkdir(join(temporary, "output"));
    await writeFile(join(temporary, "rulesync.json"), "{}", { mode: 0o600 });
    await writeFile(join(temporary, ".rulesync/mcp.json"), canonical({ mcpServers: sourceServers }), { mode: 0o600 });
    const { generate } = await import("rulesync");
    const result = await generate({ configPath: "rulesync.json", inputRoot: temporary,
      outputRoots: [join(temporary, "output")], targets: [target.rulesyncTarget], features: ["mcp"],
      global: false, delete: false, dryRun: false, check: false, silent: true });
    if (result.sourceLoadFailedFeatures.length || result.mcpCount !== 1 || !result.mcpPaths.includes(target.path)) {
      fail("Rulesync could not convert MCP configuration");
    }
    const image = await readImage(join(temporary, "output", target.path));
    if (!image) fail("Rulesync did not produce MCP configuration");
    const root = agent === "codex" ? parseToml(data(image!).toString("utf8")) : object(imageJson(image!));
    const actual = object(root[target.key]);
    if (agent === "opencode" && Object.hasOwn(root, "tools")) fail("Rulesync emitted unsupported MCP tool permissions");
    if (canonical(actual) !== canonical(expected)) fail("Rulesync changed or dropped an MCP field");
    return actual;
  } finally { await rm(temporary, { recursive: true, force: true }); }
};
