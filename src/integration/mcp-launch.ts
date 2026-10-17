import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, modeError, parseJson } from "../contracts/index.js";
import type { Agent, McpServer } from "../contracts/index.js";
import { object } from "./fs.js";
import { assertMcpSelection, inspectMcp, renderMcpServers } from "./mcp.js";

type Launch = Readonly<{ argv: readonly string[]; cleanup: () => Promise<void>; verify?: (snapshot: string) => void }>;
const empty = (): Launch => ({ argv: [], cleanup: async () => undefined });

// Config/read supplies these defaults even when they are absent in the TOML source.
const codexDefinition = (value: unknown): Record<string, unknown> => Object.fromEntries(Object.entries(object(value))
  .filter(([key, field]) => !(key === "enabled" && field === true || key === "environment_id" && field === "local"
    || key === "tool_timeout_sec" && field === null || key === "args" && Array.isArray(field) && field.length === 0)));

const toml = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value)
    .map(([key, field]) => `${JSON.stringify(key)}=${toml(field)}`).join(",")}}`;
  throw modeError("E_CONFIG", "MCP value cannot be represented in a Codex override");
};

export const prepareMcpLaunch = async ({ agent, cwd, servers, codexSnapshot }: Readonly<{
  agent: Agent; cwd: string; servers: Readonly<Record<string, McpServer>>; codexSnapshot?: string;
}>): Promise<Launch> => {
  const desired = await renderMcpServers(agent, servers);
  if (!Object.keys(servers).length) {
    await assertMcpSelection({ agent, targetHome: homedir(), cwd }, servers);
    return empty();
  }
  const current = await inspectMcp({ agent, targetHome: homedir(), cwd }, servers);
  const effective = agent === "codex" ? object(object(parseJson(codexSnapshot ?? "{}")).config).mcp_servers : current;
  if (agent === "codex" && (effective === undefined || effective === null)) {
    throw modeError("E_CODEX_CONFIG", "Effective Codex MCP configuration is unavailable");
  }
  const existing = object(effective);
  Object.entries(desired).forEach(([name, definition]) => {
    if (!Object.hasOwn(existing, name)) return;
    const native = agent === "codex" ? codexDefinition(existing[name]) : existing[name];
    const expected = agent === "codex" ? codexDefinition(definition) : definition;
    // A whole-table -c assignment still merges: equality is required before injection.
    if (canonical(native) !== canonical(expected)) {
      throw modeError("E_INSTALL_CONFLICT", "Native MCP server differs from the selected definition; remove the conflict explicitly", { name });
    }
  });
  if (agent === "codex") return {
    argv: Object.entries(desired).flatMap(([name, definition]) => Object.hasOwn(existing, name) ? []
      : ["-c", `mcp_servers.${name}=${toml(definition)}`]),
    cleanup: async () => undefined,
    verify: snapshot => {
      const after = object(object(object(parseJson(snapshot)).config).mcp_servers);
      const normalized = (map: Readonly<Record<string, unknown>>): unknown => Object.fromEntries(Object.entries(map)
        .map(([name, value]) => [name, codexDefinition(value)]));
      if (canonical(normalized(after)) !== canonical(normalized({ ...existing, ...desired }))) {
        throw modeError("E_CODEX_CONFIG", "Effective Codex MCP configuration differs after injection");
      }
    },
  };
  const directory = await mkdtemp(join(await realpath(tmpdir()), "modeck-mcp-run-"));
  try {
    const path = join(directory, "mcp.json");
    await writeFile(path, `${JSON.stringify({ mcpServers: desired })}\n`, { mode: 0o600, flag: "wx" });
    return { argv: ["--mcp-config", path], cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
};
