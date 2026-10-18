import { chmod, lstat, mkdir, opendir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonical, LIMITS, modeError, sha256 } from "../contracts/index.js";
import type { PluginAgent, PluginBundle, PluginDynamic, PluginProjection, TreeEntry } from "../contracts/index.js";
import { childPath, compare, exists, regularBytes, requireValue, safePath, utf8 } from "../resources/fs.js";
import { fromFiles, validateEntries, writeSnapshot } from "../resources/tree.js";
import type { FileData, Snapshot } from "../resources/tree.js";
import { pluginFiles } from "./bundle.js";

const inside = (path: string, parent: string): boolean => path === parent || path.startsWith(`${parent}/`);
const object = (value: unknown, path: string): Record<string, unknown> => {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "E_INTEGRITY", "Invalid native plugin manifest", { path });
  return value as Record<string, unknown>;
};
const manifestPaths = (value: unknown): string[] => value === undefined ? [] : (Array.isArray(value) ? value : [value])
  .filter((path): path is string => typeof path === "string").map(path => path.replace(/^\.\//u, "").replace(/\/$/u, ""));
const safeRelative = (path: string): boolean => path.length > 0 && !path.startsWith("/") && !path.split("/").some(part => part === ".." || part === ".git");
const replaceManifest = (files: Map<string, Buffer>, path: string, mutate: (value: Record<string, unknown>) => void): void => {
  const bytes = files.get(path);
  if (!bytes) return;
  const value = object(JSON.parse(utf8(bytes)) as unknown, path);
  mutate(value);
  files.set(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
};
const replaceLegacyRootVariables = (value: unknown, root: string): unknown => {
  if (typeof value === "string") return value.replaceAll("${PLUGIN_ROOT}", root).replaceAll("${CLAUDE_PLUGIN_ROOT}", root);
  if (Array.isArray(value)) return value.map(item => replaceLegacyRootVariables(item, root));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, replaceLegacyRootVariables(item, root)]));
  return value;
};
const portablePluginCwd = (value: unknown): boolean => {
  if (typeof value !== "string" || value.includes("\\")) return false;
  if (value === "./") return true;
  if (value.startsWith("./")) return safeRelative(value.slice(2));
  return ["${PLUGIN_ROOT}", "${PLUGIN_DATA}"].some(token => value === token
    || value.startsWith(`${token}/`) && (value.slice(token.length + 1) === "" || safeRelative(value.slice(token.length + 1))));
};
const validatePortableMcp = (value: unknown, path: string): void => {
  const file = object(value, path);
  requireValue(file["$schema"] === "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
    && Object.keys(file).every(key => key === "$schema" || key === "mcpServers"),
  "E_INTEGRITY", "Codex portable MCP config must use the locally supported Agent Plugins schema without unknown fields", { path });
  const servers = object(file.mcpServers, path);
  for (const [name, raw] of Object.entries(servers)) {
    requireValue(name.length > 0, "E_INTEGRITY", "Codex portable MCP server names cannot be empty", { path });
    const server = object(raw, `${path}:${name}`);
    const type = server.type;
    const allowed = type === "stdio" ? ["type", "command", "args", "env", "cwd"]
      : type === "streamable-http" ? ["type", "url", "headers"] : [];
    requireValue(allowed.length > 0 && Object.keys(server).every(key => allowed.includes(key)),
      "E_INTEGRITY", "Codex portable MCP server uses an unsupported transport or field", { path, server: name, type });
    if (type === "stdio") {
      requireValue(typeof server.command === "string" && server.command.length > 0
        && (!server.command.includes("/") && !server.command.includes("\\") || server.command.startsWith("./") && !server.command.includes("\\") && safeRelative(server.command.slice(2)))
        && (server.args === undefined || Array.isArray(server.args) && server.args.every(item => typeof item === "string"))
        && (server.env === undefined || object(server.env, `${path}:${name}:env`) && Object.values(server.env as Record<string, unknown>).every(item => typeof item === "string"))
        && (server.cwd === undefined || portablePluginCwd(server.cwd)),
      "E_INTEGRITY", "Codex portable stdio MCP server is invalid", { path, server: name });
      const env = (server.env ?? {}) as Record<string, string>;
      requireValue(!Object.keys(env).some(key => key === "PLUGIN_ROOT" || key === "PLUGIN_DATA"),
        "E_INTEGRITY", "Codex portable MCP env cannot override reserved plugin root variables", { path, server: name });
    } else {
      requireValue(typeof server.url === "string" && server.url.length > 0
        && (server.headers === undefined || Object.values(object(server.headers, `${path}:${name}:headers`)).every(item => typeof item === "string")),
      "E_INTEGRITY", "Codex portable HTTP MCP server is invalid", { path, server: name });
      let url: URL;
      try { url = new URL(server.url as string); }
      catch { throw modeError("E_INTEGRITY", "Codex portable MCP URL is invalid", { path, server: name }); }
      requireValue(["http:", "https:"].includes(url.protocol) && Boolean(url.hostname)
        && !url.username && !url.password && !url.hash
        && (url.protocol === "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)),
      "E_INTEGRITY", "Codex portable MCP URL must be secure HTTP(S) without userinfo or fragments", { path, server: name });
    }
    const checkRootTokens = (item: unknown, field = ""): void => {
      if (typeof item === "string") {
        const tokens = ["${PLUGIN_ROOT}", "${PLUGIN_DATA}", "${CLAUDE_PLUGIN_ROOT}"].filter(token => item.includes(token));
        requireValue(tokens.every(token => token !== "${CLAUDE_PLUGIN_ROOT}" && ["args", "env", "cwd"].includes(field)),
          "E_INTEGRITY", "Codex portable MCP uses a root variable in a field the native parser does not expand", { path, server: name, field });
      } else if (Array.isArray(item)) item.forEach(child => checkRootTokens(child, field));
      else if (item && typeof item === "object") Object.entries(item as Record<string, unknown>)
        .forEach(([key, child]) => checkRootTokens(child, key));
    };
    checkRootTokens(server);
  }
};
const projectCodexMcp = (bundle: PluginBundle, files: Map<string, Buffer>, manifestPath: string): void => {
  const manifest = object(JSON.parse(utf8(files.get(manifestPath)!)) as unknown, manifestPath);
  if (manifestPath === "plugin.json") {
    if (!files.has("mcp.json")) return;
    const path = "mcp.json";
    const config = object(JSON.parse(utf8(files.get(path)!)) as unknown, path);
    validatePortableMcp(config, path);
    return;
  }
  const declaration = manifest.mcpServers;
  if (declaration === undefined) {
    const path = ".mcp.json";
    if (!files.has(path)) return;
    const value = JSON.parse(utf8(files.get(path)!)) as unknown;
    files.set(path, Buffer.from(`${JSON.stringify(replaceLegacyRootVariables(value, bundle.root), null, 2)}\n`));
    return;
  }
  if (typeof declaration === "string") {
    const candidate = manifestPaths(declaration)[0];
    if (typeof candidate !== "string" || !safeRelative(candidate) || !files.has(candidate)) {
      throw modeError("E_INTEGRITY", "Codex legacy MCP config path is missing or unsafe", { manifestPath, path: candidate });
    }
    const mcpPath: string = candidate;
    const value = JSON.parse(utf8(files.get(mcpPath)!)) as unknown;
    files.set(mcpPath, Buffer.from(`${JSON.stringify(replaceLegacyRootVariables(value, bundle.root), null, 2)}\n`));
  } else {
    requireValue(declaration && typeof declaration === "object" && !Array.isArray(declaration),
      "E_INTEGRITY", "Codex legacy inline MCP config is invalid", { manifestPath });
    const replaced = replaceLegacyRootVariables(declaration, bundle.root);
    files.set(manifestPath, Buffer.from(`${JSON.stringify({ ...manifest, mcpServers: replaced }, null, 2)}\n`));
  }
};
const projectionMarkerName = ".modeck-plugin-projection.json";
const projectionMarkerTempName = ".modeck-plugin-projection.json.tmp";
const treeOnDisk = async (root: string, entries: readonly TreeEntry[], allowMarkerTemp = false): Promise<Snapshot> => {
  const actual: string[] = [];
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    requireValue(depth <= LIMITS.scanDepth, "E_LIMIT", "Plugin projection scan depth exceeded");
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const name = entry.name;
      const relative = prefix ? `${prefix}/${name}` : name;
      if (relative === projectionMarkerName || allowMarkerTemp && relative === projectionMarkerTempName) continue;
      const path = childPath(root, relative);
      const stat = await lstat(path);
      requireValue(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()), "E_INTEGRITY", "Plugin projection contains a link or special file", { path: relative });
      actual.push(relative);
      requireValue(actual.length <= LIMITS.treeEntries, "E_LIMIT", "Plugin projection scan entry limit exceeded");
      if (stat.isDirectory()) await walk(path, relative, depth + 1);
    }
  };
  await walk(root, "", 0);
  actual.sort(compare);
  requireValue(canonical(actual) === canonical(entries.map(entry => entry.path)), "E_INSTALL_CONFLICT", "Plugin projection contains missing or unowned files");
  const dirs = entries.filter((entry): entry is Extract<TreeEntry, {kind:"directory"}> => entry.kind === "directory");
  const files = await Promise.all(entries.filter((entry): entry is Extract<TreeEntry, {kind:"file"}> => entry.kind === "file").map(async entry => {
    const path = childPath(root, entry.path);
    const file = await regularBytes(path, LIMITS.fileBytes);
    return { path: entry.path, bytes: file.bytes, executable: file.executable };
  }));
  return fromFiles(dirs.map(entry => entry.path), files);
};
export type PluginProjectionPlan = PluginProjection & { readonly stagingRoot: string };
type ProjectionPlanData = { readonly snapshot: Snapshot; readonly marker: Record<string, unknown>; readonly fingerprint: string };
const projectionPlans = new WeakMap<PluginProjectionPlan, ProjectionPlanData>();
const projectionFingerprint = (plan: PluginProjectionPlan): string => sha256(Buffer.from(canonical({
  id: plan.id, name: plan.name, root: plan.root, digest: plan.digest, components: plan.components, stagingRoot: plan.stagingRoot,
})));
const markerBytes = (marker: Record<string, unknown>): Buffer => Buffer.from(`${JSON.stringify(marker, null, 2)}\n`);
const markerPrefix = (bytes: Buffer, expected: Buffer): boolean => bytes.length <= expected.length
  && Buffer.compare(expected.subarray(0, bytes.length), bytes) === 0;
const validateMarkerArtifact = async (path: string, marker: Record<string, unknown>): Promise<"absent" | "exact" | "prefix"> => {
  if (!await exists(path)) return "absent";
  const data = await regularBytes(path, LIMITS.manifestBytes);
  if (markerPrefix(data.bytes, markerBytes(marker))) {
    return data.bytes.length === markerBytes(marker).length ? "exact" : "prefix";
  }
  try {
    const parsed = object(JSON.parse(utf8(data.bytes)) as unknown, path);
    requireValue(canonical(parsed) === canonical(marker), "E_INSTALL_CONFLICT", "Plugin projection marker differs from its prepared plan", { path });
    return "exact";
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && String(error.code).startsWith("E_")) throw error;
    throw modeError("E_INSTALL_CONFLICT", "Plugin projection marker is not a valid planned write prefix", { path });
  }
};
const writeProjectionMarker = async (root: string, marker: Record<string, unknown>): Promise<void> => {
  const markerPath = join(root, ".modeck-plugin-projection.json");
  const temporaryPath = join(root, projectionMarkerTempName);
  const expected = markerBytes(marker);
  const current = await validateMarkerArtifact(markerPath, marker);
  if (current === "exact") {
    const temporary = await validateMarkerArtifact(temporaryPath, marker);
    if (temporary !== "absent") await unlink(temporaryPath);
    return;
  }
  if (current === "prefix") await unlink(markerPath);
  const temporary = await validateMarkerArtifact(temporaryPath, marker);
  if (temporary === "exact") {
    await rename(temporaryPath, markerPath);
    return;
  }
  if (temporary === "prefix") await unlink(temporaryPath);
  await writeFile(temporaryPath, expected, { flag: "wx", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, markerPath);
};
const verifyProjectionContents = async (root: string, snapshot: Snapshot, marker: Record<string, unknown>): Promise<void> => {
  const markerPath = join(root, ".modeck-plugin-projection.json");
  const actualMarker = object(JSON.parse(utf8((await regularBytes(markerPath, LIMITS.manifestBytes)).bytes)) as unknown, markerPath);
  requireValue(canonical(actualMarker) === canonical(marker), "E_INSTALL_CONFLICT", "Plugin projection marker differs from its prepared plan", { path: root });
  const actual = await treeOnDisk(root, snapshot.entries);
  requireValue(canonical(actual.entries) === canonical(snapshot.entries), "E_INSTALL_CONFLICT", "Plugin projection tree differs from its prepared plan", { path: root });
};
const verifyProjectionStagePrefix = async (root: string, snapshot: Snapshot): Promise<{ prefixValid: true; contentComplete: boolean }> => {
  const expected = new Map(snapshot.entries.map(entry => [entry.path, entry]));
  const actual: string[] = [];
  let filesComplete = true;
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    requireValue(depth <= LIMITS.scanDepth, "E_LIMIT", "Plugin projection staging depth exceeded");
    const handle = await opendir(directory);
    for await (const child of handle) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      const entry = expected.get(relative);
      if (!entry) throw modeError("E_INSTALL_CONFLICT", "Plugin projection staging contains an unowned path", { path: relative });
      const path = childPath(root, relative);
      const stat = await lstat(path);
      requireValue(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile())
        && (stat.isDirectory() ? entry.kind === "directory" : entry.kind === "file"),
      "E_INSTALL_CONFLICT", "Plugin projection staging path type differs from its plan", { path: relative });
      actual.push(relative);
      requireValue(actual.length <= LIMITS.treeEntries, "E_LIMIT", "Plugin projection staging entry limit exceeded");
      if (stat.isDirectory()) await walk(path, relative, depth + 1);
      else {
        const data = await regularBytes(path, LIMITS.fileBytes);
        const file = snapshot.files.get(relative);
        if (!file || data.executable !== file.executable || data.bytes.length > file.bytes.length
          || Buffer.compare(Buffer.from(file.bytes.subarray(0, data.bytes.length)), data.bytes) !== 0) {
          throw modeError("E_INSTALL_CONFLICT", "Plugin projection staging file is not a planned write prefix", { path: relative });
        }
        if (data.bytes.length !== file.bytes.length) filesComplete = false;
      }
    }
  };
  await walk(root, "", 0);
  const pathsComplete = canonical(actual.sort(compare)) === canonical(snapshot.entries.map(entry => entry.path));
  return { prefixValid: true, contentComplete: pathsComplete && filesComplete };
};
const removeProjectionStage = async (root: string, snapshot: Snapshot): Promise<void> => {
  const expected = new Map(snapshot.entries.map(entry => [entry.path, entry]));
  const removeTree = async (directory: string, prefix: string): Promise<void> => {
    await chmod(directory, 0o700);
    const handle = await opendir(directory);
    for await (const child of handle) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      const entry = expected.get(relative);
      if (!entry) throw modeError("E_INSTALL_CONFLICT", "Plugin projection staging contains an unowned path", { path: relative });
      const path = childPath(root, relative);
      const stat = await lstat(path);
      requireValue(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile())
        && (stat.isDirectory() ? entry.kind === "directory" : entry.kind === "file"),
      "E_INSTALL_CONFLICT", "Plugin projection staging path type differs from its plan", { path: relative });
      if (stat.isDirectory()) {
        await removeTree(path, relative);
        await rmdir(path);
      } else {
        const data = await regularBytes(path, LIMITS.fileBytes);
        const file = snapshot.files.get(relative);
        requireValue(file && data.executable === file.executable && data.bytes.length <= file.bytes.length
          && Buffer.compare(Buffer.from(file.bytes.subarray(0, data.bytes.length)), data.bytes) === 0,
        "E_INSTALL_CONFLICT", "Plugin projection staging file is not a planned write prefix", { path: relative });
        await unlink(path);
      }
    }
  };
  await removeTree(root, "");
  await rmdir(root);
};
const inventory = (files: ReadonlyMap<string, Buffer>, agent: PluginAgent, dynamic: readonly PluginDynamic[]): { manifests: string[]; dynamicDirs: Set<string>; components: string[] } => {
  const cc = files.has(".claude-plugin/plugin.json") ? ".claude-plugin/plugin.json" : null;
  const portable = files.has("plugin.json") ? "plugin.json" : null;
  const legacy = files.has(".codex-plugin/plugin.json") ? ".codex-plugin/plugin.json" : null;
  const codex = portable ?? legacy;
  const primary = agent === "claude" ? cc : codex;
  requireValue(primary, "E_INTEGRITY", `Plugin has no ${agent} manifest`);
  const manifests = [primary!];
  const componentKeys = ["commands", "agents", "hooks", "mcpServers", "lspServers", "outputStyles", "workflows", "experimental", "channels", "settings", "userConfig", "dependencies", "apps", "onboardingSkill"];
  const unsupportedCodex = ["commands", "agents", "lspServers", "outputStyles", "workflows", "experimental", "channels", "settings", "userConfig", "dependencies"];
  const components = new Set<string>();
  // These are actual native default scan roots. Arbitrary SKILL.md files elsewhere
  // are assets unless a selected manifest declares that directory as a skill root.
  const dynamicDirs = new Set(["skills", "rules"]);
  if ([...files.keys()].some(path => path.startsWith(".codex-plugin/migrated-command-skills/"))) {
    dynamicDirs.add(".codex-plugin/migrated-command-skills");
  }
  for (const resource of dynamic) {
    if (resource.kind === "skill" && (!resource.agents || resource.agents.includes(agent))) dynamicDirs.add(resource.path);
    if (resource.kind === "rule") dynamicDirs.add(resource.path);
  }
  // Only the selected agent's effective manifest determines its dynamic scan roots.
  const candidates = [primary!];
  for (const manifest of candidates) {
    const value = object(JSON.parse(utf8(files.get(manifest)!)) as unknown, manifest);
    const extensions = value.extensions === undefined ? {} : object(value.extensions, manifest);
    const extensionValue = manifest === portable ? extensions["com.openai"] : undefined;
    const extension = extensionValue === undefined ? {} : object(extensionValue, manifest);
    if (manifest === portable) {
      requireValue(extension.skills === undefined, "E_INTEGRITY", "Codex portable extensions cannot declare alternate skill scan paths");
      requireValue(extension.auth === undefined, "E_INTEGRITY", "This Codex CLI portable plugin loader does not load extensions.com.openai.auth; refusing to imply native authentication is configured", { manifest });
      const allowed = new Set(["apps", "hooks", "interface", "onboardingSkill", "defaultPrompt"]);
      requireValue(Object.keys(extension).every(key => allowed.has(key)), "E_INTEGRITY", "Unknown Codex plugin extension cannot be safely projected", { manifest });
    }
    for (const declaration of [value.skills, extension.skills]) {
      manifestPaths(declaration).forEach(path => {
        requireValue(safeRelative(path) && path.length > 0, "E_PATH", "Plugin skill path escapes its root", { manifest, path });
        if ((manifest === cc && path !== "skills") || (manifest === codex && path !== "skills")) dynamicDirs.add(path);
        if (agent === "codex" && manifest === portable) {
          requireValue(path === "skills", "E_INTEGRITY", "Codex portable plugins only support the conventional root skills directory", { path, manifest });
        }
      });
    }
    if (manifest === portable && value.extensions !== undefined) {
      const extensions = object(value.extensions, manifest);
      for (const namespace of Object.keys(extensions)) requireValue(namespace === "com.openai", "E_INTEGRITY", "Unknown Codex plugin extension cannot be safely projected", { namespace });
    }
  }
  for (const manifest of manifests) {
    const value = object(JSON.parse(utf8(files.get(manifest)!)) as unknown, manifest);
    const extensions = value.extensions === undefined ? {} : object(value.extensions, manifest);
    const extensionValue = manifest === portable ? extensions["com.openai"] : undefined;
    const extension = extensionValue === undefined ? {} : object(extensionValue, manifest);
    const keys = componentKeys.filter(key => value[key] !== undefined || extension[key] !== undefined);
    if (agent === "codex" && manifest === portable && (value.hooks !== undefined || extension.hooks !== undefined)) {
      throw modeError("E_INTEGRITY", "Codex CLI portable plugin loader does not load declared lifecycle hooks; refusing to imply they were installed", { manifest });
    }
    if (agent === "codex" && manifest === portable
      && (value.apps !== undefined || extension.apps !== undefined)) {
      throw modeError("E_INTEGRITY", "This Codex CLI portable plugin loader does not load plugin apps", { manifest });
    }
    requireValue(value.dependencies === undefined || Array.isArray(value.dependencies) && value.dependencies.length === 0,
      "E_INTEGRITY", "Plugin dependencies would install additional native plugins and are not supported", { manifest });
    if (agent === "codex") {
      requireValue(!keys.some(key => unsupportedCodex.includes(key)), "E_INTEGRITY", "Codex does not support a declared Claude-native plugin component", { manifest, components: keys.filter(key => unsupportedCodex.includes(key)) });
    }
    keys.forEach(key => components.add(key));
    const staticValue = { ...value, ...extension };
    for (const key of ["commands", "agents", "hooks", "mcpServers", "lspServers", "outputStyles", "workflows", "experimental", "onboardingSkill"]) {
      const raw = staticValue[key];
      const declaredPaths = typeof raw === "string" || Array.isArray(raw) ? manifestPaths(raw)
        : raw && typeof raw === "object" ? Object.values(raw as Record<string, unknown>).flatMap(item =>
          item && typeof item === "object" && "source" in item ? manifestPaths((item as Record<string, unknown>).source)
            : typeof item === "string" ? [item] : []) : [];
      declaredPaths.forEach(path => {
        requireValue(safeRelative(path), "E_PATH", "Plugin component path escapes its root", { path });
        if ([...dynamicDirs].some(directory => path === directory || path.startsWith(`${directory}/`))
          || path.startsWith("skills/") || path.startsWith("rules/")) {
          throw modeError("E_INTEGRITY", "A static plugin component refers to mode-selected content", { manifest, component: key, path });
        }
      });
    }
  }
  // Probe default native component locations too; otherwise projection would silently drop them.
  if (agent === "codex") {
    const defaults: Readonly<Record<string, readonly string[]>> = {
      commands: ["commands"], agents: ["agents"], lspServers: [".lsp.json"], outputStyles: ["output-styles"],
      workflows: ["workflows"], experimental: ["themes", "monitors/monitors.json"], apps: [".app.json"],
    };
    const found = Object.entries(defaults).flatMap(([component, candidatesAtRoot]) => candidatesAtRoot
      .filter(path => files.has(path) || [...files.keys()].some(candidate => candidate.startsWith(`${path}/`)))
      .map(path => `${component}:${path}`));
    requireValue(found.length === 0, "E_INTEGRITY", "Codex cannot safely load default-scanned native components in this plugin", { components: found });
    const manifest = object(JSON.parse(utf8(files.get(primary!)!)) as unknown, primary!);
    if (codex === portable ? files.has("mcp.json") : manifest.mcpServers !== undefined || files.has(".mcp.json")) {
      components.add("mcpServers");
    }
  }
  return { manifests, dynamicDirs, components: [...components].sort(compare) };
};

export type CodexPluginProjectionExpectations = Readonly<{
  loader: "portable" | "legacy";
  mcpServerNames: readonly string[];
  hookEventNames: readonly string[];
}>;

const readJsonFile = (files: ReadonlyMap<string, Buffer>, path: string): unknown => {
  requireValue(safeRelative(path) && files.has(path), "E_INTEGRITY", "Plugin component declaration is missing or unsafe", { path });
  try { return JSON.parse(utf8(files.get(path)!)) as unknown; }
  catch { throw modeError("E_INTEGRITY", "Plugin component declaration is not valid JSON", { path }); }
};

const mcpNamesFrom = (value: unknown, path: string): string[] => {
  const config = object(value, path);
  const servers = config.mcpServers;
  if (servers === undefined) return [];
  if (Array.isArray(servers)) {
    requireValue(servers.every(name => typeof name === "string" && name.length > 0), "E_INTEGRITY", "Plugin MCP server names are malformed", { path });
    return [...servers] as string[];
  }
  return Object.keys(object(servers, path)).sort(compare);
};

const hookNamesFrom = (value: unknown, path: string, events: Set<string>): void => {
  const root = object(value, path);
  const hooks = root.hooks === undefined ? root : object(root.hooks, path);
  for (const event of Object.keys(hooks)) events.add(event.replace(/[^a-z0-9]/giu, "").toLowerCase());
};

/** Return Codex loader-visible MCP and hook identities from the same effective manifest used by projection. */
export const codexPluginProjectionExpectations = async (bundle: PluginBundle): Promise<CodexPluginProjectionExpectations> => {
  const files = await pluginFiles(bundle);
  const selected = inventory(files, "codex", bundle.dynamic);
  const manifestPath = selected.manifests[0]!;
  const manifest = object(readJsonFile(files, manifestPath), manifestPath);
  const portable = manifestPath === "plugin.json";
  let mcpServerNames: string[] = [];
  if (portable) {
    if (files.has("mcp.json")) mcpServerNames = mcpNamesFrom(readJsonFile(files, "mcp.json"), "mcp.json");
  } else {
    const declaration = manifest.mcpServers;
    if (typeof declaration === "string") {
      const path = manifestPaths(declaration)[0];
      if (typeof path !== "string" || !safeRelative(path)) throw modeError("E_INTEGRITY", "Codex legacy MCP config path is missing or unsafe", { path });
      mcpServerNames = mcpNamesFrom(readJsonFile(files, path), path);
    } else if (declaration !== undefined) {
      mcpServerNames = mcpNamesFrom({ mcpServers: declaration }, manifestPath);
    } else if (files.has(".mcp.json")) {
      mcpServerNames = mcpNamesFrom(readJsonFile(files, ".mcp.json"), ".mcp.json");
    }
  }
  const hookEventNames = new Set<string>();
  if (!portable) {
    const visit = (value: unknown): void => {
      if (typeof value === "string") {
        const path = manifestPaths(value)[0];
        if (typeof path !== "string" || !safeRelative(path)) throw modeError("E_INTEGRITY", "Codex legacy hook config path is missing or unsafe", { path });
        hookNamesFrom(readJsonFile(files, path), path, hookEventNames);
      } else if (Array.isArray(value)) value.forEach(visit);
      else hookNamesFrom(value, manifestPath, hookEventNames);
    };
    if (manifest.hooks === undefined) {
      if (files.has("hooks/hooks.json")) hookNamesFrom(readJsonFile(files, "hooks/hooks.json"), "hooks/hooks.json", hookEventNames);
    } else visit(manifest.hooks);
  }
  return { loader: portable ? "portable" : "legacy", mcpServerNames: [...new Set(mcpServerNames)].sort(compare),
    hookEventNames: [...hookEventNames].sort(compare) };
};

const projectedSnapshot = (bundle: PluginBundle, agent: PluginAgent, files: ReadonlyMap<string, Buffer>): Snapshot => {
  const selected = inventory(files, agent, bundle.dynamic);
  const retained = new Map([...files].filter(([path]) => ![...selected.dynamicDirs].some(directory => inside(path, directory))));
  const allManifests = [".claude-plugin/plugin.json", "plugin.json", ".codex-plugin/plugin.json"].filter(path => files.has(path));
  allManifests.filter(path => !selected.manifests.includes(path)).forEach(path => retained.delete(path));
  selected.manifests.forEach(path => replaceManifest(retained, path, value => {
    delete value.skills;
    if (path === "plugin.json" && value.extensions && typeof value.extensions === "object") {
      const extensions = value.extensions as Record<string, unknown>;
      if (extensions["com.openai"] && typeof extensions["com.openai"] === "object") {
        delete (extensions["com.openai"] as Record<string, unknown>).skills;
      }
    }
  }));
  if (agent === "codex") projectCodexMcp(bundle, retained, selected.manifests[0]!);
  const allDynamicPaths = bundle.dynamic.map(resource => resource.path);
  const dynamicRoots = new Set(["skills", "rules", ...allDynamicPaths.flatMap(path => {
    const slash = path.lastIndexOf("/");
    return slash > 0 ? [path.slice(0, slash)] : [path];
  })]);
  for (const [path, bytes] of retained) {
    if (!/\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|json|toml|yaml|yml|md)$/iu.test(path)) continue;
    const text = bytes.toString("utf8");
    const dependsOnDynamic = [...dynamicRoots].some(dynamic => {
      const escaped = dynamic.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return new RegExp(`(?:\\./|/)${escaped}(?:/|[\\s"'\x60]|$)`, "u").test(text);
    }) || /\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}[^\n]*(?:\/skills(?:\/|\b)|\/rules(?:\/|\b))/u.test(text);
    requireValue(!dependsOnDynamic, "E_INTEGRITY", "Static plugin component refers to a mode-selected path", { path });
  }
  const directories = bundle.entries.filter((entry): entry is Extract<TreeEntry, {kind:"directory"}> => entry.kind === "directory")
    .map(entry => entry.path).filter(path => ![...selected.dynamicDirs].some(directory => inside(path, directory)));
  const data = bundle.entries.filter((entry): entry is Extract<TreeEntry, {kind:"file"}> => entry.kind === "file")
    .filter(entry => retained.has(entry.path)).map(entry => ({ path: entry.path, bytes: retained.get(entry.path)!, executable: entry.executable }));
  return fromFiles(directories, data);
};
export const planPluginProjection = async (bundle: PluginBundle, agent: PluginAgent, targetRoot: string,
  configIdentity = "unmanaged"): Promise<PluginProjectionPlan> => {
  requireValue(bundle.spec.agents === undefined || bundle.spec.agents.includes(agent), "E_CONFIG", "Plugin is not enabled for this agent", { id: bundle.id, agent });
  requireValue(configIdentity === "unmanaged" || /^[a-f0-9]{64}$/u.test(configIdentity), "E_CONFIG", "Invalid plugin projection config identity");
  const sourceFiles = await pluginFiles(bundle);
  const snapshot = projectedSnapshot(bundle, agent, sourceFiles);
  validateEntries(snapshot.entries);
  const owner = "modeck/native-plugin-projection/v1";
  const digest = sha256(Buffer.from(canonical({ owner, configIdentity, agent, plugin: bundle.id, commit: bundle.commit, treeDigest: snapshot.treeDigest })));
  const root = await safePath(targetRoot, true);
  const stagingRoot = join(dirname(root), `.${basename(root)}-${digest.slice(0, 12)}.stage`);
  await safePath(stagingRoot, true);
  const marker = { version: 1, owner, configIdentity, id: bundle.id, agent, digest, commit: bundle.commit, treeDigest: snapshot.treeDigest };
  const plan: PluginProjectionPlan = { id: bundle.id, name: bundle.name, root, digest,
    components: inventory(sourceFiles, agent, bundle.dynamic).components, stagingRoot };
  projectionPlans.set(plan, { snapshot, marker, fingerprint: projectionFingerprint(plan) });
  return plan;
};

export const publishPluginProjection = async (plan: PluginProjectionPlan, journalStageRoot = plan.stagingRoot): Promise<PluginProjection> => {
  const prepared = projectionPlans.get(plan);
  if (!prepared || prepared.fingerprint !== projectionFingerprint(plan) || journalStageRoot !== plan.stagingRoot) {
    throw modeError("E_INTEGRITY", "Plugin projection plan or journal staging path changed");
  }
  const snapshot = prepared.snapshot;
  const root = await safePath(plan.root, true);
  const stage = await safePath(journalStageRoot, true);
  requireValue(root === plan.root && stage === plan.stagingRoot && dirname(root) === dirname(stage),
    "E_PATH", "Plugin projection stage must be a sibling of its published root");
  if (await exists(root)) {
    await verifyProjectionContents(root, snapshot, prepared.marker);
    return { id: plan.id, name: plan.name, root, digest: plan.digest, components: plan.components };
  }
  await mkdir(dirname(root), { recursive: true, mode: 0o700 });
  if (await exists(stage)) {
    const markerPath = join(stage, projectionMarkerName);
    const markerTempPath = join(stage, projectionMarkerTempName);
    if (await exists(markerPath) || await exists(markerTempPath)) {
      await validateMarkerArtifact(markerPath, prepared.marker);
      await validateMarkerArtifact(markerTempPath, prepared.marker);
      const actual = await treeOnDisk(stage, snapshot.entries, true);
      requireValue(canonical(actual.entries) === canonical(snapshot.entries), "E_INSTALL_CONFLICT", "Marked staged projection is incomplete or differs from its plan", { path: stage });
      await writeProjectionMarker(stage, prepared.marker);
    } else if ((await verifyProjectionStagePrefix(stage, snapshot)).contentComplete) {
      const actual = await treeOnDisk(stage, snapshot.entries);
      requireValue(canonical(actual.entries) === canonical(snapshot.entries), "E_INSTALL_CONFLICT", "Complete staged projection differs from its plan", { path: stage });
      await writeProjectionMarker(stage, prepared.marker);
    } else {
      await removeProjectionStage(stage, snapshot);
    }
    if (await exists(stage) && await exists(join(stage, ".modeck-plugin-projection.json"))) {
      await verifyProjectionContents(stage, snapshot, prepared.marker);
      requireValue(!await exists(root), "E_INSTALL_CONFLICT", "Plugin projection target appeared during publication", { path: root });
      await rename(stage, root);
      return { id: plan.id, name: plan.name, root, digest: plan.digest, components: plan.components };
    }
  }
  await writeSnapshot(snapshot, stage, false);
  const actual = await treeOnDisk(stage, snapshot.entries);
  requireValue(canonical(actual.entries) === canonical(snapshot.entries), "E_INTEGRITY", "Staged plugin projection failed full-tree verification", { path: stage });
  await writeProjectionMarker(stage, prepared.marker);
  await verifyProjectionContents(stage, snapshot, prepared.marker);
  requireValue(!await exists(root), "E_INSTALL_CONFLICT", "Plugin projection target appeared during publication", { path: root });
  await rename(stage, root);
  return { id: plan.id, name: plan.name, root, digest: plan.digest, components: plan.components };
};

export const projectPlugin = async (bundle: PluginBundle, agent: PluginAgent, targetRoot: string,
  configIdentity = "unmanaged"): Promise<PluginProjection> =>
  publishPluginProjection(await planPluginProjection(bundle, agent, targetRoot, configIdentity));
