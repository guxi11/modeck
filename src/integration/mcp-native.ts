import { dirname, join } from "node:path";
import { readdir } from "node:fs/promises";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { applyEdits, getNodeValue, modify, parseTree } from "jsonc-parser";
import type { Node, ParseError } from "jsonc-parser";
import { agentDefinitions, canonical, isAgent, modeError } from "../contracts/index.js";
import type { Agent, FileImage, McpLocation, McpLocationRequest } from "../contracts/index.js";
import { data, imageJson, jsonImage, missing, object, readImage, safeAbsolute } from "./fs.js";

export type { McpLocation, McpLocationRequest } from "../contracts/index.js";
const ancestorRoots = (cwd: string): readonly string[] => dirname(cwd) === cwd ? [cwd] : [cwd, ...ancestorRoots(dirname(cwd))];
const firstFile = async (paths: readonly string[]): Promise<string> => {
  const found = await Promise.all(paths.map(async path => await readImage(path) ? path : null));
  return found.find(path => path !== null) ?? paths[0]!;
};
export const codebuddyMcpCandidates = (home: string, cwd: string) => ({
  user: [join(home, ".codebuddy/.mcp.json"), join(home, ".codebuddy/mcp.json"), join(home, ".codebuddy.json")],
  project: [join(cwd, ".mcp.json"), join(cwd, "mcp.json")],
} as const);
const agentConfigHome = (agent: Agent, home: string): string => {
  const { configDirectory, configEnvironment } = agentDefinitions[agent];
  const expected = join(home, configDirectory);
  const configured = process.env[configEnvironment];
  if (configured !== undefined && configured !== expected) {
    throw modeError("E_CONFIG", "An alternate agent configuration home cannot be safely synchronized");
  }
  return expected;
};
export const mcpLocation = async ({ agent, targetHome, cwd, scope = agent === "codex" ? "user" : "project" }: McpLocationRequest): Promise<McpLocation> => {
  if (!isAgent(agent)) throw modeError("E_CONFIG", "Unsupported MCP agent");
  const home = await safeAbsolute(targetHome);
  const project = await safeAbsolute(cwd);
  const configHome = agentConfigHome(agent, home);
  const candidates = codebuddyMcpCandidates(home, project);
  if (scope !== "user" && scope !== "project") throw modeError("E_USAGE", "Unknown MCP scope");
  if (agent === "codex" && scope === "project") throw modeError("E_CONFIG", "modeck supports Codex user scope only; native trusted-project MCP is outside this synchronization implementation");
  // Explicit CLAUDE_CONFIG_DIR relocates the user/local MCP store, even at the default directory.
  const user = agent === "claude" ? join(process.env.CLAUDE_CONFIG_DIR === undefined ? home : configHome, ".claude.json") : agent === "codex" ? join(home, ".codex/config.toml")
    : await firstFile(candidates.user);
  const local = agent === "claude" ? join(project, ".mcp.json") : agent === "codex" ? join(project, ".codex/config.toml")
    : await firstFile(candidates.project);
  const path = scope === "user" ? user : local;
  const checks = agent === "codex" ? [user, ...ancestorRoots(project).map(root => join(root, ".codex/config.toml"))]
    : agent === "claude" ? [user, local] : [join(home, ".codebuddy.json"), ...candidates.user, ...candidates.project];
  const topLevel = agent === "codebuddy" ? [...new Set([user, local])]
    : agent === "codex" ? [...new Set([user, ...ancestorRoots(project).toReversed().map(root => join(root, ".codex/config.toml"))])] : [...new Set(checks)];
  const active = agent === "codebuddy" ? [user, local, join(home, ".codebuddy.json")] : topLevel;
  return { path, key: agent === "codex" ? "mcp_servers" : "mcpServers", checks: [...new Set(checks)], active: [...new Set(active)],
    topLevel,
    localStore: agent === "codebuddy" ? join(home, ".codebuddy.json") : agent === "claude" ? user : null };
};

export const assertDefaultCodexProfile = async ({ agent, targetHome }: McpLocationRequest): Promise<void> => {
  if (agent !== "codex") return;
  const directory = agentConfigHome(agent, await safeAbsolute(targetHome));
  await safeAbsolute(directory);
  const names = await readdir(directory).catch(error => { if (missing(error)) return []; throw error; });
  if (names.some(name => name.endsWith(".config.toml"))) {
    throw modeError("E_CONFIG", "modeck synchronizes only the default Codex user snapshot; named *.config.toml profiles were found and native --profile is outside its synchronization contract");
  }
};

const jsoncRoot = (text: string): Record<string, unknown> => {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length || tree?.type !== "object") throw modeError("E_CONFIG", "Invalid native JSONC configuration");
  const check = (node: Node): void => {
    if (node.type === "object") {
      const keys: unknown[] = (node.children ?? []).map(property => property.children?.[0]?.value);
      if (new Set(keys).size !== keys.length || keys.some(key => typeof key !== "string"
        || ["__proto__", "prototype", "constructor"].includes(key))) throw modeError("E_CONFIG", "Duplicate or unsafe native JSONC key");
    }
    node.children?.forEach(check);
  };
  check(tree);
  const root = object(getNodeValue(tree));
  canonical(root);
  return root;
};

export const nativeRoot = (agent: Agent, image: FileImage | null): Record<string, unknown> => {
  if (!image) return {};
  const bytes = data(image);
  if (bytes.includes(Buffer.from("GENERATED by evoloop"))) throw modeError("E_INSTALL_CONFLICT", "A generator owns the MCP configuration");
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return agent === "codex" ? parseToml(text) : agent === "codebuddy" ? jsoncRoot(text) : object(imageJson(image));
  }
  catch { throw modeError("E_CONFIG", "Cannot parse native MCP configuration"); }
};
export const nativeServers = (root: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> =>
  Object.hasOwn(root, key) ? object(root[key]) : {};
export const nativeImage = (agent: Agent, root: Readonly<Record<string, unknown>>, mode = 0o600, before?: FileImage | null): FileImage => {
  if (agent === "codebuddy" && before) {
    const original = data(before).toString("utf8");
    const current = nativeServers(nativeRoot(agent, before), "mcpServers");
    const desired = nativeServers(root, "mcpServers");
    const names = [...new Set([...Object.keys(current), ...Object.keys(desired)])].filter(name =>
      Object.hasOwn(current, name) !== Object.hasOwn(desired, name) || canonical(current[name]) !== canonical(desired[name]));
    const text = names.reduce((source, name) => applyEdits(source, modify(source, ["mcpServers", name],
      Object.hasOwn(desired, name) ? desired[name] : undefined,
      { formattingOptions: { insertSpaces: true, tabSize: 2, eol: original.includes("\r\n") ? "\r\n" : "\n" } })), original);
    const image: FileImage = { data: text, encoding: "utf8", mode };
    if (canonical(nativeRoot(agent, image)) !== canonical(root)) throw modeError("E_CONFIG", "Cannot preserve unrelated native JSONC configuration");
    return image;
  }
  if (agent !== "codex") return jsonImage(root, mode);
  try { return { data: stringifyToml(root), encoding: "utf8", mode }; }
  catch { throw modeError("E_CONFIG", "Cannot preserve native TOML configuration"); }
};

export const checkMcpPolicy = async ({ agent, targetHome, cwd }: McpLocationRequest): Promise<readonly string[]> => {
  if (!isAgent(agent)) throw modeError("E_CONFIG", "Unsupported MCP agent");
  const home = await safeAbsolute(targetHome);
  const project = await safeAbsolute(cwd);
  const configDir = agentDefinitions[agent].configDirectory;
  agentConfigHome(agent, home);
  const system = process.platform === "darwin" ? agent === "claude" ? "/Library/Application Support/ClaudeCode" : agent === "codebuddy" ? "/Library/Application Support/CodeBuddy" : "/Library/Application Support/Codex"
    : agent === "claude" ? "/etc/claude-code" : agent === "codebuddy" ? "/etc/codebuddy" : "/etc/codex";
  const unixCodex = process.platform === "darwin" ? "/private/etc/codex" : "/etc/codex";
  const systemConfig = agent === "codex" ? join(unixCodex, "config.toml") : null;
  const policies = [join(system, "managed-mcp.json"), join(system, "managed-settings.json"),
    join(home, configDir, "managed-mcp.json"), join(home, configDir, "managed-settings.json"),
    ...(agent === "codex" ? [join(unixCodex, "requirements.toml"), join(unixCodex, "managed_config.toml"), join(home, ".codex/requirements.toml")] : [])];
  await Promise.all([join(system, "managed-settings.d"), join(home, configDir, "managed-settings.d")].map(async directory => {
    await safeAbsolute(directory);
    const entries = await readdir(directory).catch(error => { if (missing(error)) return []; throw error; });
    if (entries.length) throw modeError("E_CONFIG", "Managed policy fragments require native administration; synchronization refused");
  }));
  await Promise.all(policies.map(async path => {
    if (await readImage(path)) throw modeError("E_CONFIG", "Managed MCP policy requires native administration; synchronization refused");
  }));
  if (systemConfig) {
    const root = nativeRoot(agent, await readImage(systemConfig));
    const containsMcp = (value: unknown): boolean => value !== null && typeof value === "object"
      && Object.entries(value).some(([key, child]) => /mcp/iu.test(key) || containsMcp(child));
    if (containsMcp(root)) throw modeError("E_CONFIG", "System Codex MCP policy requires native administration; synchronization refused");
  }
  const settings = agent === "codex" ? [] : [join(home, configDir, "settings.json"), join(project, configDir, "settings.json"), join(project, configDir, "settings.local.json")];
  await Promise.all(settings.map(async path => {
    const image = await readImage(path);
    if (!image) return;
    const root = nativeRoot(agent, image);
    if (["allowedMcpServers", "deniedMcpServers", "allowManagedMcpServersOnly", "managedMcpServers"].some(key => Object.hasOwn(root, key))) {
      throw modeError("E_CONFIG", "MCP policy cannot be safely evaluated; synchronization refused");
    }
  }));
  return [...policies, ...settings, ...(systemConfig ? [systemConfig] : [])];
};

export const assertMcpPolicy = async (request: McpLocationRequest): Promise<void> => {
  await checkMcpPolicy(request);
};
