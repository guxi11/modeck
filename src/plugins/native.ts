import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { LIMITS, modeError } from "../contracts/index.js";
import type { PluginAgent } from "../contracts/index.js";
import { regularBytes, requireValue, utf8 } from "../resources/fs.js";
import { safeAbsolute } from "../integration/fs.js";

export type NativePlugin = { readonly name: string; readonly marketplace: string; readonly installed: boolean; readonly enabled: boolean;
  readonly scope: string | null; readonly version: string | null; readonly installPath: string | null;
  readonly sourcePath: string | null; readonly marketplacePath: string | null; readonly mcpServerNames: readonly string[] | null };
export type NativeMarketplace = { readonly name: string; readonly root: string };

const executable = (agent: PluginAgent): string => agent === "claude" ? "claude" : "codex";
const writeOperation = (args: readonly string[]): boolean => args[0] === "plugin"
  && ((args[1] === "marketplace" && ["add", "remove"].includes(args[2] ?? ""))
    || ["install", "uninstall", "add", "remove"].includes(args[1] ?? ""));
const ensurePrivateConfigHome = async (agent: PluginAgent, home: string): Promise<void> => {
  await safeAbsolute(home);
  const homeStat = await lstat(home);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || homeStat.uid !== process.getuid?.()) {
    throw modeError("E_PATH", "Native plugin target home must be a real directory owned by the current user");
  }
  const configHome = join(home, agent === "claude" ? ".claude" : ".codex");
  await safeAbsolute(configHome);
  const existing = await lstat(configHome).catch(error => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) {
    try {
      await mkdir(configHome, { mode: 0o700 });
      await chmod(configHome, 0o700);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  const stat = await lstat(configHome);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw modeError("E_INSTALL_CONFLICT", "Native plugin configuration directory must be privately owned and cannot be a symlink");
  }
};
const safeDiagnostic = (value: string, home: string): string => value
  .replaceAll(home, "<target-home>")
  .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/giu, "https://<redacted>@")
  .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 <redacted>")
  .replace(/((?:authorization|access[_-]?token|refresh[_-]?token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;"']+/giu, "$1<redacted>")
  .replace(/[\r\n\t]+/gu, " ").trim().slice(0, 600);
const envFor = (agent: PluginAgent, home: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { HOME: home };
  for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (agent === "claude") env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  else env.CODEX_HOME = join(home, ".codex");
  return env;
};

export const nativeRun = async (agent: PluginAgent, home: string, args: readonly string[], cwd = home): Promise<string> => {
  const bin = executable(agent);
  if (writeOperation(args)) await ensurePrivateConfigHome(agent, home);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { cwd: home, env: envFor(agent, home), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { child.kill("SIGKILL"); return; }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("error", error => { clearTimeout(timeout); reject(modeError("E_PLATFORM", `Cannot run ${bin}`, { cause: String(error) })); });
    child.once("close", code => {
      clearTimeout(timeout);
      if (code !== 0) {
        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = Buffer.concat(stderr).toString("utf8");
        const output = safeDiagnostic(`${stdoutText}\n${stderrText}`, home);
        const errorOutput = output;
        if (args[0] === "plugin" && ["install", "add"].includes(args[1] ?? "")
          && /trust|confirm|approval|permission/iu.test(output)) {
          reject(modeError("E_IO", `Native plugin installation requires interactive trust confirmation; retry in the agent CLI${errorOutput ? `: ${errorOutput}` : ""}`, { exitCode: code }));
          return;
        }
        reject(modeError("E_IO", `${bin} ${args.slice(0, 3).join(" ")} failed${errorOutput ? `: ${errorOutput}` : ""}`, { exitCode: code }));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
};

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const parseRows = (value: unknown, agent: PluginAgent): NativePlugin[] => {
  const envelopes = Array.isArray(value) ? { installed: value } : object(value);
  if (!envelopes) throw modeError("E_PLATFORM", `${agent} plugin list returned an unsupported JSON shape`);
  const installedRows = Array.isArray(envelopes.installed) ? envelopes.installed
    : agent === "claude" && Array.isArray(envelopes.plugins) ? envelopes.plugins : null;
  if (!installedRows || (envelopes.available !== undefined && !Array.isArray(envelopes.available))) {
    throw modeError("E_PLATFORM", `${agent} plugin list omitted its recognized installed array`);
  }
  const parse = (row: unknown, installedFallback: boolean): NativePlugin => {
    const item = object(row);
    if (!item) throw modeError("E_PLATFORM", `${agent} plugin list contains a malformed row`);
    let name: string | undefined;
    let marketplace: string | undefined;
    for (const key of ["id", "pluginId"]) if (typeof item[key] === "string") {
      const separator = (item[key] as string).lastIndexOf("@");
      if (separator <= 0 || separator === (item[key] as string).length - 1) throw modeError("E_PLATFORM", `${agent} plugin list contains a malformed plugin identity`);
      name ??= (item[key] as string).slice(0, separator);
      marketplace ??= (item[key] as string).slice(separator + 1);
    }
    if (typeof item.name === "string") name ??= item.name;
    if (typeof item.marketplaceName === "string") marketplace ??= item.marketplaceName;
    if (!name || !marketplace) throw modeError("E_PLATFORM", `${agent} plugin list row lacks a name or marketplace identity`);
    const source = object(item.source);
    const marketplaceSource = object(item.marketplaceSource);
    const getPath = (...values: unknown[]): string | null => {
      const found = values.find(value => typeof value === "string");
      return typeof found === "string" ? found : null;
    };
    const installed = typeof item.installed === "boolean" ? item.installed : installedFallback;
    const enabled = typeof item.enabled === "boolean" ? item.enabled : true;
    const mcpServers = item.mcpServers;
    const mcpServerNames = mcpServers === undefined ? null : Array.isArray(mcpServers)
      && mcpServers.every(server => typeof server === "string") ? mcpServers as string[]
      : mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)
        ? Object.keys(mcpServers as Record<string, unknown>) : null;
    if (mcpServers !== undefined && mcpServerNames === null) {
      throw modeError("E_PLATFORM", `${agent} plugin list contains malformed MCP server inventory`);
    }
    return { name, marketplace, installed, enabled,
      scope: typeof item.scope === "string" ? item.scope : agent === "codex" ? "user" : null,
      version: typeof item.version === "string" ? item.version : null,
      installPath: getPath(item.installPath, item.installedPath),
      sourcePath: getPath(item.readFromFolder, source?.path),
      marketplacePath: getPath(item.marketplacePath, marketplaceSource?.source),
      mcpServerNames,
    };
  };
  const rows = [...installedRows.map(row => parse(row, true)),
    ...(Array.isArray(envelopes.available) ? envelopes.available.map(row => parse(row, false)) : [])];
  if (new Set(rows.map(row => `${row.name}@${row.marketplace}`)).size !== rows.length) {
    throw modeError("E_PLATFORM", `${agent} plugin list contains duplicate plugin identities`);
  }
  return rows;
};

export const nativePlugins = async (agent: PluginAgent, home: string, cwd = home): Promise<NativePlugin[]> => {
  const output = await nativeRun(agent, home, ["plugin", "list", "--json"], cwd);
  let value: unknown;
  try { value = JSON.parse(output); }
  catch { throw modeError("E_PLATFORM", `${agent} plugin list returned unsupported output`); }
  const rows = parseRows(value, agent);
  const marketplaceRoots = new Map((await nativeMarketplaces(agent, home, cwd)).map(item => [item.name, item.root]));
  const enriched = rows.map(row => ({ ...row, marketplacePath: row.marketplacePath ?? marketplaceRoots.get(row.marketplace) ?? null }));
  if (agent === "claude" && enriched.some(row => row.installed && (!row.installPath || !row.sourcePath || row.scope !== "user"))) {
    throw modeError("E_PLATFORM", "Claude plugin list omitted user scope or install/source paths required for safe ownership checks");
  }
  return enriched;
};

export const nativeMarketplaces = async (agent: PluginAgent, home: string, cwd = home): Promise<NativeMarketplace[]> => {
  const output = await nativeRun(agent, home, ["plugin", "marketplace", "list", "--json"], cwd);
  let value: unknown;
  try { value = JSON.parse(output); }
  catch { throw modeError("E_PLATFORM", `${agent} marketplace list returned unsupported output`); }
  const envelope = object(value);
  const entries = Array.isArray(value) ? value : envelope && Array.isArray(envelope.marketplaces)
    ? envelope.marketplaces : null;
  if (!entries) throw modeError("E_PLATFORM", `${agent} marketplace list returned an unsupported JSON shape`);
  return entries.map(item => {
    const object = item && typeof item === "object" ? item as Record<string, unknown> : null;
    if (!object) throw modeError("E_PLATFORM", `${agent} marketplace list contains a malformed row`);
    const root = typeof object.path === "string" ? object.path : typeof object.root === "string" ? object.root : undefined;
    if (typeof object.name !== "string" || !root) throw modeError("E_PLATFORM", `${agent} marketplace row omitted its name or root`);
    return { name: object.name, root };
  });
};

export const nativeMarketplacePluginNames = async (agent: PluginAgent, home: string, cwd: string): Promise<NativePlugin[]> => {
  const marketplaces = await nativeMarketplaces(agent, home, cwd);
  const roots = new Set([join(home, ".agents", "plugins"), join(cwd, ".agents", "plugins"), join(cwd, ".claude-plugin"),
    ...marketplaces.flatMap(item => [join(item.root, ".agents", "plugins"), join(item.root, ".claude-plugin")])]);
  const found: NativePlugin[] = [];
  for (const root of roots) {
    const path = join(root, "marketplace.json");
    try {
      await safeAbsolute(path);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw modeError("E_PATH", "Unsafe native marketplace catalog");
      const catalog = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      const name = typeof catalog.name === "string" ? catalog.name : marketplaces.find(item => item.root === root)?.name;
      if (!name || !Array.isArray(catalog.plugins)) throw modeError("E_INTEGRITY", "Native marketplace catalog has no valid name/plugin list");
      for (const plugin of catalog.plugins) {
        if (!plugin || typeof plugin !== "object" || typeof (plugin as Record<string, unknown>).name !== "string") {
          throw modeError("E_INTEGRITY", "Native marketplace catalog contains a malformed plugin entry");
        }
        found.push({ name: (plugin as { name: string }).name, marketplace: name, installed: false, enabled: true, scope: null,
          version: null, installPath: null, sourcePath: null, marketplacePath: root, mcpServerNames: null });
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      if (error instanceof Error && "code" in error && String(error.code).startsWith("E_")) throw error;
      throw modeError("E_INTEGRITY", "Cannot safely inspect an existing native marketplace catalog");
    }
  }
  return found;
};

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const serverNames = (value: unknown): string[] => {
  const root = record(value);
  const servers = record(root?.mcpServers) ?? record(root?.mcp_servers);
  return servers ? Object.keys(servers) : [];
};
const readJsonNames = async (path: string, required = false): Promise<string[]> => {
  await safeAbsolute(path);
  const stat = await lstat(path).catch(error => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) {
    if (required) throw modeError("E_INSTALL_CONFLICT", "Native plugin MCP declaration points to a missing file");
    return [];
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw modeError("E_INSTALL_CONFLICT", "Cannot safely inspect MCP names in a native plugin");
  let value: unknown;
  try { value = JSON.parse(utf8((await regularBytes(path, LIMITS.manifestBytes)).bytes)) as unknown; }
  catch { throw modeError("E_INSTALL_CONFLICT", "Cannot safely parse MCP declarations in a native plugin"); }
  const root = record(value);
  if (!root) throw modeError("E_INSTALL_CONFLICT", "Native plugin manifest has an invalid MCP declaration");
  const names = new Set<string>();
  const addDeclaration = async (declared: unknown): Promise<void> => {
    if (typeof declared === "string") {
      const relative = declared.replace(/^\.\//u, "");
      if (!relative || relative.startsWith("/") || relative.split(/[\\/]/u).some(part => part === ".." || part === "")) {
        throw modeError("E_INSTALL_CONFLICT", "Native plugin MCP declaration has an unsafe path");
      }
      for (const name of await readJsonNames(join(path.slice(0, path.lastIndexOf("/")), relative), true)) names.add(name);
    } else if (Array.isArray(declared)) {
      for (const item of declared) await addDeclaration(item);
    } else if (declared !== undefined) {
      const inline = record(declared);
      if (!inline) throw modeError("E_INSTALL_CONFLICT", "Native plugin MCP declaration has an unsupported shape");
      for (const name of Object.keys(inline)) names.add(name);
    }
  };
  await addDeclaration(root.mcpServers);
  await addDeclaration(record(record(record(root.extensions)?.["com.openai"])?.mcpServers) ?? undefined);
  if (path.endsWith(".mcp.json") || path.endsWith("mcp.json")) {
    for (const name of serverNames(root)) names.add(name);
  }
  return [...names];
};

export const nativePluginMcpNamesAt = async (agent: PluginAgent, root: string): Promise<string[]> => {
  await safeAbsolute(root);
  const rootStat = await lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw modeError("E_PLATFORM", "Installed plugin files are unavailable for MCP namespace inspection");
  }
  const manifestPaths = agent === "claude"
    ? [join(root, ".claude-plugin", "plugin.json")]
    : [join(root, "plugin.json"), join(root, ".codex-plugin", "plugin.json")];
  const candidates = agent === "claude" ? [join(root, ".mcp.json")] : [join(root, "mcp.json"), join(root, ".mcp.json")];
  const names = new Set<string>();
  for (const manifest of manifestPaths) for (const name of await readJsonNames(manifest)) names.add(name);
  for (const candidate of candidates) for (const name of await readJsonNames(candidate)) names.add(name);
  return [...names];
};

export const nativeInstalledPluginMcpNames = async (agent: PluginAgent, home: string, plugin: NativePlugin): Promise<string[]> => {
  if (!plugin.installed || !plugin.enabled) return [];
  if (plugin.mcpServerNames) return [...plugin.mcpServerNames];
  let root = plugin.installPath ?? plugin.sourcePath;
  if (!root && agent === "codex" && plugin.version) {
    root = join(home, ".codex", "plugins", "cache", plugin.marketplace, plugin.name, plugin.version);
  }
  if (!root) throw modeError("E_PLATFORM", "Installed plugin MCP inventory is unavailable; refusing to apply an unchecked server namespace", { plugin: plugin.name });
  return nativePluginMcpNamesAt(agent, root);
};

export const nativeConfiguredMcpNames = async (agent: PluginAgent, home: string, cwd: string): Promise<string[]> => {
  const paths = agent === "claude"
    ? [join(home, ".claude", ".claude.json"), join(cwd, ".mcp.json")]
    : [join(home, ".codex", "config.toml"), ...[cwd, ...ancestors(cwd)].map(root => join(root, ".codex", "config.toml"))];
  const names = new Set<string>();
  for (const path of new Set(paths)) {
    await safeAbsolute(path);
    const stat = await lstat(path).catch(error => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    let value: unknown;
    try {
      const source = utf8((await regularBytes(path, LIMITS.fileBytes)).bytes);
      value = agent === "claude" ? JSON.parse(source) as unknown : parseToml(source);
    } catch { throw modeError("E_INSTALL_CONFLICT", "Cannot safely parse the native MCP namespace"); }
    for (const name of serverNames(value)) names.add(name);
    if (agent === "claude") {
      const projectConfig = record(record(record(value)?.projects)?.[cwd]);
      for (const name of serverNames(projectConfig)) names.add(name);
    }
  }
  return [...names];
};

const ancestors = (path: string): string[] => {
  const parent = join(path, "..");
  return parent === path ? [] : [parent, ...ancestors(parent)];
};

export const preflightName = async (agent: PluginAgent, home: string, name: string, marketplace: string,
  owned: boolean, cwd = home): Promise<void> => {
  const [inventory, catalogs] = await Promise.all([
    nativePlugins(agent, home, cwd), nativeMarketplacePluginNames(agent, home, cwd),
  ]);
  const sameNameInstalled = inventory.filter(plugin => plugin.installed && plugin.name === name);
  requireValue(sameNameInstalled.length === 0, "E_INSTALL_CONFLICT", sameNameInstalled.some(plugin => plugin.marketplace !== marketplace)
    ? "Native plugin name conflicts with another marketplace"
    : "A same-name native plugin is already installed; ownership requires a recorded install fingerprint", { name });
  const sameNameCatalogs = catalogs.filter(plugin => plugin.name === name);
  requireValue(sameNameCatalogs.every(plugin => owned && plugin.marketplace === marketplace),
    "E_INSTALL_CONFLICT", "Native plugin name is present in another marketplace catalog", { name, marketplace });
  requireValue(inventory.filter(plugin => plugin.installed).every(plugin => plugin.name !== name),
    "E_INSTALL_CONFLICT", "Native plugin name conflicts with another marketplace", { name });
};

export const nativeMarketplaceAdd = async (agent: PluginAgent, home: string, path: string, cwd = home): Promise<void> => {
  await nativeRun(agent, home, agent === "claude"
    ? ["plugin", "marketplace", "add", path, "--scope", "user"]
    : ["plugin", "marketplace", "add", path, "--json"], cwd);
};
export const nativeMarketplaceRemove = async (agent: PluginAgent, home: string, name: string, cwd = home): Promise<void> => {
  await nativeRun(agent, home, agent === "claude"
    ? ["plugin", "marketplace", "remove", name]
    : ["plugin", "marketplace", "remove", name, "--json"], cwd);
};
const installPathFromOutput = (agent: PluginAgent, output: string): string | null => {
  if (agent !== "codex" || !output.trim()) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(output) as unknown; }
  catch { return null; }
  const paths: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    const row = value as Record<string, unknown>;
    for (const key of ["installedPath", "installPath", "installed_path", "install_path"]) {
      if (row[key] !== undefined) {
        if (typeof row[key] !== "string" || row[key].length === 0) {
          throw modeError("E_PLATFORM", "Codex plugin add returned a malformed install path");
        }
        paths.push(row[key]);
      }
    }
    for (const [key, child] of Object.entries(row)) if (!/[Tt]oken|[Pp]assword|[Ss]ecret|[Aa]uth/iu.test(key)) visit(child, depth + 1);
  };
  visit(parsed, 0);
  const unique = [...new Set(paths)];
  requireValue(unique.length <= 1, "E_PLATFORM", "Codex plugin add returned conflicting install paths");
  return unique[0] ?? null;
};

export const nativePluginAdd = async (agent: PluginAgent, home: string, name: string, marketplace: string, cwd = home): Promise<string | null> => {
  const output = await nativeRun(agent, home, agent === "claude"
    ? ["plugin", "install", `${name}@${marketplace}`, "--scope", "user", "--json"]
    : ["plugin", "add", `${name}@${marketplace}`, "--json"], cwd);
  return installPathFromOutput(agent, output);
};
export const nativePluginRemove = async (agent: PluginAgent, home: string, name: string, marketplace: string, cwd = home): Promise<void> => {
  await nativeRun(agent, home, agent === "claude"
    ? ["plugin", "uninstall", `${name}@${marketplace}`, "--scope", "user", "--keep-data"]
    : ["plugin", "remove", `${name}@${marketplace}`, "--json"], cwd);
};

export const assertInstalled = async (agent: PluginAgent, home: string, name: string, marketplace: string, cwd = home): Promise<boolean> =>
  (await nativePlugins(agent, home, cwd)).some(plugin => plugin.name === name && plugin.marketplace === marketplace && plugin.installed);

export const defaultHome = (): string => homedir();
