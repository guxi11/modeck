import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonical, LIMITS, modeError, sha256 } from "../contracts/index.js";
import type { ConfigContext, PluginAgent, PluginBundle, PluginProjection, PluginRequest, TreeEntry } from "../contracts/index.js";
import { checkDirectory, safeAbsolute } from "../integration/fs.js";
import { exists, regularBytes, utf8 } from "../resources/fs.js";
import { loadConfig } from "../core/config.js";
import { requireValue } from "../resources/fs.js";
import { loadRegistry, registryRoot } from "../integration/registry.js";
import { initPluginBundles, readPluginBundles } from "./bundle.js";
import { pluginFiles } from "./bundle.js";
import { codexPluginProjectionExpectations, planPluginProjection, publishPluginProjection } from "./projection.js";
import { nativeMarketplaces, nativeMarketplaceAdd, nativeMarketplaceRemove, nativePlugins,
  nativePluginAdd, nativePluginRemove, nativeInstalledPluginMcpNames, nativePluginMcpNamesAt,
  nativeConfiguredMcpNames, preflightName } from "./native.js";
import { configKey, pluginsRoot, readState, statePath, writeState, withPluginMutex } from "./state.js";
import type { ManagedPlugin, NativeFingerprint, PluginState } from "./state.js";
import { treeDigest } from "../resources/tree.js";
import { verifyCodexMarketplaceProjection } from "./codexProbe.js";

type Action = "init" | "status" | "apply" | "remove" | "recover";
const config = async (request: PluginRequest): Promise<ConfigContext> => loadConfig({ configRoot: request.configRoot });
const nativeHome = async (request: PluginRequest): Promise<string> => {
  await safeAbsolute(request.targetHome);
  await safeAbsolute(request.cwd);
  const stat = await lstat(request.targetHome).catch(() => null);
  requireValue(stat?.isDirectory(), "E_PATH", "Plugin target home must be an existing directory");
  const cwdStat = await lstat(request.cwd).catch(() => null);
  requireValue(cwdStat?.isDirectory(), "E_PATH", "Plugin working directory must be an existing directory");
  await checkDirectory(request.targetHome);
  const nativeConfigHome = join(request.targetHome, request.agent === "claude" ? ".claude" : ".codex");
  await safeAbsolute(nativeConfigHome);
  const configStat = await lstat(nativeConfigHome).catch(() => null);
  requireValue(!configStat || configStat.isDirectory() && !configStat.isSymbolicLink(), "E_PATH",
    "Native config home must be a real directory under targetHome");
  return request.targetHome;
};
const marketName = (root: string, agent: PluginAgent): string => `modeck-${sha256(Buffer.from(`${root}\0${agent}`)).slice(0, 16)}`;
const generationDigest = (key: string, agent: PluginAgent, plugins: readonly Pick<ManagedPlugin, "id" | "name" | "commit" | "sourceDigest">[]): string =>
  sha256(Buffer.from(canonical({ config: key, agent, plugins: [...plugins].map(({ id, name, commit, sourceDigest }) =>
    ({ id, name, commit, sourceDigest })).sort((a, b) => a.id.localeCompare(b.id)) })));
const marketRoot = (home: string, key: string, agent: PluginAgent, generation: string): string =>
  join(pluginsRoot(home), key, agent, "marketplaces", generation);
const projectionStageRoot = (plugin: Pick<ManagedPlugin, "expectedPath" | "digest">): string =>
  join(dirname(plugin.expectedPath), `.${basename(plugin.expectedPath)}-${plugin.digest.slice(0, 12)}.stage`);
const directoryDigest = async (root: string): Promise<string> => {
  await safeAbsolute(root);
  const entries: TreeEntry[] = [];
  let bytes = 0;
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    requireValue(depth <= LIMITS.scanDepth, "E_LIMIT", "Native plugin tree depth limit exceeded");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (path === ".modeck-plugin-projection.json") continue;
      const full = join(root, path);
      await safeAbsolute(full);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) throw modeError("E_INSTALL_CONFLICT", "Native plugin tree contains a symlink", { path });
      requireValue(entries.length < LIMITS.treeEntries, "E_LIMIT", "Native plugin tree entry limit exceeded");
      if (stat.isDirectory()) { entries.push({ path, kind: "directory" }); await walk(full, path, depth + 1); }
      else if (stat.isFile()) {
        const file = await regularBytes(full, LIMITS.fileBytes);
        bytes += file.bytes.length;
        requireValue(bytes <= LIMITS.treeBytes, "E_LIMIT", "Native plugin tree byte limit exceeded");
        entries.push({ path, kind: "file", bytes: file.bytes.length, digest: sha256(file.bytes), executable: file.executable });
      } else throw modeError("E_INSTALL_CONFLICT", "Native plugin tree contains a special file", { path });
    }
  };
  const rootStat = await lstat(root);
  requireValue(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "E_INSTALL_CONFLICT", "Native plugin path is not a safe directory", { root });
  await walk(root, "", 0);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return treeDigest(entries);
};
const projectionTreeDigest = async (plugin: ManagedPlugin, agent: PluginAgent, configIdentity: string): Promise<string> => {
  const markerPath = join(plugin.expectedPath, ".modeck-plugin-projection.json");
  const marker = JSON.parse(utf8((await regularBytes(markerPath, 64 * 1024)).bytes)) as Record<string, unknown>;
  const owner = "modeck/native-plugin-projection/v1";
  requireValue(marker.version === 1 && marker.owner === owner && marker.configIdentity === configIdentity
    && marker.id === plugin.id && marker.agent === agent && marker.digest === plugin.digest && marker.commit === plugin.commit
    && /^[a-f0-9]{64}$/u.test(String(marker.treeDigest)), "E_INTEGRITY", "Plugin projection ownership marker does not match its journal", { id: plugin.id });
  const expectedDigest = sha256(Buffer.from(canonical({ owner, configIdentity, agent, plugin: plugin.id, commit: plugin.commit, treeDigest: marker.treeDigest })));
  requireValue(expectedDigest === plugin.digest && await directoryDigest(plugin.expectedPath) === marker.treeDigest,
    "E_PLAN_STALE", "Managed plugin projection contents or integrity marker drifted", { id: plugin.id });
  return String(marker.treeDigest);
};
const codexProbePlugins = async (bundles: readonly PluginBundle[], projections: readonly PluginProjection[]) => {
  const expected = await Promise.all(bundles.map(codexPluginProjectionExpectations));
  return projections.map((projection, index) => ({ name: projection.name, expectedPath: projection.root,
    components: projection.components, expectedMcp: expected[index]!.mcpServerNames,
    expectedHooks: expected[index]!.hookEventNames }));
};
const samePath = async (actual: string | null, expected: string): Promise<boolean> => {
  if (!actual) return false;
  const canonicalPath = async (path: string): Promise<string> => {
    try {
      const resolved = await realpath(path);
      await safeAbsolute(resolved);
      return resolved;
    } catch { return ""; }
  };
  const [actualPath, expectedPath] = await Promise.all([canonicalPath(actual), canonicalPath(expected)]);
  return actualPath !== "" && actualPath === expectedPath;
};
const codexCacheInstallPath = async (home: string, marketplace: string, plugin: ManagedPlugin,
  version: string | null, expectedTree: string): Promise<string | null> => {
  const cacheRoot = join(home, ".codex", "plugins", "cache", marketplace, plugin.name);
  await safeAbsolute(cacheRoot);
  const rootStat = await lstat(cacheRoot).catch(error => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!rootStat) return null;
  requireValue(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "E_INSTALL_CONFLICT",
    "Codex plugin cache path is not a safe directory", { name: plugin.name });
  const matches: string[] = [];
  for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
    if ((version !== null && entry.name !== version) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = join(cacheRoot, entry.name);
    if (await directoryDigest(candidate) === expectedTree) matches.push(candidate);
  }
  requireValue(matches.length <= 1, "E_INSTALL_CONFLICT", "Codex plugin cache has ambiguous matching installed trees", { name: plugin.name });
  return matches[0] ?? null;
};
const currentFingerprint = async (request: PluginRequest, state: PluginState, plugin: ManagedPlugin,
  installPathHint: string | null = null): Promise<NativeFingerprint | null> => {
  const expectedTree = await projectionTreeDigest(plugin, request.agent, configKey(state.configRoot));
  const matches = (await nativePlugins(request.agent, request.targetHome, request.cwd))
    .filter(item => item.name === plugin.name && item.marketplace === state.marketplace && item.installed);
  if (matches.length === 0) return null;
  requireValue(matches.length === 1, "E_INSTALL_CONFLICT", "Native plugin inventory has duplicate installed identities", { name: plugin.name });
  const row = matches[0]!;
  requireValue(row.enabled, "E_PLAN_STALE", "Managed plugin enabled state drifted; refusing removal", { name: plugin.name });
  requireValue(row.scope === "user", "E_PLAN_STALE", "Managed plugin scope drifted; refusing removal", { name: plugin.name });
  let installPath: string | null = row.installPath ?? installPathHint ?? plugin.fingerprint?.installPath ?? null;
  if (request.agent === "codex") {
    const cachePath = await codexCacheInstallPath(request.targetHome, state.marketplace, plugin, row.version, expectedTree);
    if (installPath) requireValue(cachePath && await samePath(installPath, cachePath), "E_PLAN_STALE",
      "Codex installed path does not match its verified marketplace cache tree", { name: plugin.name });
    installPath = cachePath;
  }
  requireValue(await samePath(row.sourcePath, plugin.expectedPath)
    && await samePath(row.marketplacePath, state.marketplaceRoot) && installPath !== null,
  "E_PLAN_STALE", "Native plugin source or install identity drifted; refusing removal", { name: plugin.name });
  const sourceDigest = await directoryDigest(row.sourcePath!);
  const contentDigest = await directoryDigest(installPath!);
  requireValue(sourceDigest === expectedTree && contentDigest === expectedTree,
    "E_PLAN_STALE", "Native plugin source or installed contents drifted; refusing removal", { name: plugin.name });
  return { name: plugin.name, marketplace: state.marketplace, installed: true, enabled: row.enabled,
    version: row.version, scope: row.scope!, installPath: installPath!, sourcePath: row.sourcePath!, marketplacePath: row.marketplacePath!,
    contentDigest, sourceDigest };
};
const publishMarketplaceCatalog = async (path: string, text: string): Promise<void> => {
  const parent = dirname(path);
  await safeAbsolute(parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await safeAbsolute(parent);
  const expected = Buffer.from(text, "utf8");
  const existing = await lstat(path).catch(error => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  const handle = await open(path, constants.O_RDWR | (existing ? 0 : constants.O_CREAT | constants.O_EXCL) | constants.O_NOFOLLOW, 0o600);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.uid !== process.getuid?.() || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600
      || existing && (opened.dev !== existing.dev || opened.ino !== existing.ino || existing.isSymbolicLink())) {
      throw modeError("E_INSTALL_CONFLICT", "Managed marketplace catalog is not a private owned file");
    }
    const current = await handle.readFile();
    if (current.equals(expected)) return;
    requireValue(current.length < expected.length && Buffer.compare(current, expected.subarray(0, current.length)) === 0,
      "E_INSTALL_CONFLICT", "Managed marketplace catalog differs from its journaled write intent");
    await handle.truncate(0);
    let offset = 0;
    while (offset < expected.length) {
      const { bytesWritten } = await handle.write(expected, offset, expected.length - offset, offset);
      requireValue(bytesWritten > 0, "E_IO", "Managed marketplace catalog write made no progress");
      offset += bytesWritten;
    }
    await handle.sync();
    await handle.chmod(0o600);
  } finally { await handle.close(); }
};
const writeMarketplace = async (root: string, name: string, agent: PluginAgent, bundles: readonly PluginBundle[]): Promise<void> => {
  const entries = bundles.map(bundle => ({ name: bundle.name,
    source: agent === "claude" ? `./plugins/${bundle.id}` : { source: "local", path: `./plugins/${bundle.id}` },
    ...(agent === "claude" ? {} : { policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }) }));
  if (agent === "claude") {
    await publishMarketplaceCatalog(join(root, ".claude-plugin", "marketplace.json"),
      `${JSON.stringify({ name, owner: { name: "modeck" }, plugins: entries }, null, 2)}\n`);
  } else {
    await publishMarketplaceCatalog(join(root, ".agents", "plugins", "marketplace.json"), `${JSON.stringify({ name,
      interface: { displayName: "modeck managed plugins" }, plugins: entries }, null, 2)}\n`);
  }
};
const marketplaceCatalogPath = (root: string, agent: PluginAgent): string => agent === "claude"
  ? join(root, ".claude-plugin", "marketplace.json") : join(root, ".agents", "plugins", "marketplace.json");
const validateMarketplace = async (state: PluginState, request: PluginRequest): Promise<void> => {
  const marketplaces = await nativeMarketplaces(request.agent, request.targetHome, request.cwd);
  const matching = marketplaces.find(item => item.name === state.marketplace);
  requireValue(!matching || matching.root === state.marketplaceRoot,
    "E_INSTALL_CONFLICT", "Managed marketplace name now refers to a different source", { marketplace: state.marketplace });
  await safeAbsolute(state.marketplaceRoot);
  if (!matching && !await exists(state.marketplaceRoot)) return;
  const manifestPath = marketplaceCatalogPath(state.marketplaceRoot, request.agent);
  const text = utf8((await regularBytes(manifestPath, 1024 * 1024)).bytes);
  let actual: unknown;
  try { actual = JSON.parse(text); } catch { throw modeError("E_INTEGRITY", "Managed marketplace manifest is invalid"); }
  const plugins = state.plugins.map(plugin => ({ name: plugin.name,
    source: request.agent === "claude" ? `./plugins/${plugin.id}` : { source: "local", path: `./plugins/${plugin.id}` },
    ...(request.agent === "claude" ? {} : { policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }) }));
  const expected = request.agent === "claude"
    ? { name: state.marketplace, owner: { name: "modeck" }, plugins }
    : { name: state.marketplace, interface: { displayName: "modeck managed plugins" }, plugins };
  requireValue(canonical(actual) === canonical(expected), "E_INSTALL_CONFLICT", "Managed marketplace catalog drifted; refusing native changes");
};
const validateGenerationLayout = async (state: PluginState, agent: PluginAgent,
  catalogPresent: "absent" | "optional" | "present", projectionState: "planned" | "published" = "published"): Promise<void> => {
  const names = async (path: string): Promise<string[] | null> => {
    await safeAbsolute(path);
    const stat = await lstat(path).catch(error => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return null;
    requireValue(stat.isDirectory() && !stat.isSymbolicLink(), "E_INSTALL_CONFLICT", "Managed plugin generation contains an unsafe directory", { path });
    return (await readdir(path)).sort();
  };
  const catalogRoot = agent === "claude" ? ".claude-plugin" : ".agents";
  const expectedRoot = [...(state.plugins.length ? ["plugins"] : []), ...(catalogPresent === "present" ? [catalogRoot] : [])].sort();
  const actualRoot = await names(state.marketplaceRoot);
  if (!actualRoot) {
    requireValue(catalogPresent !== "present" && (projectionState === "planned" || state.plugins.length === 0),
      "E_INSTALL_CONFLICT", "Managed plugin generation root is missing");
    return;
  }
  const allowedRoot = [...new Set([...expectedRoot, ...(catalogPresent === "optional" ? [catalogRoot] : [])])].sort();
  requireValue(actualRoot.every(entry => allowedRoot.includes(entry))
    && (catalogPresent !== "present" || canonical(actualRoot) === canonical(expectedRoot)),
  "E_INSTALL_CONFLICT", "Managed plugin generation contains paths outside its journaled owner intent", { path: state.marketplaceRoot });
  if (state.plugins.length) {
    const pluginEntries = await names(join(state.marketplaceRoot, "plugins"));
    const finalNames = state.plugins.map(plugin => plugin.id).sort();
    const stagingNames = state.plugins.map(plugin => basename(plugin.stagingRoot ?? projectionStageRoot(plugin))).sort();
    const allowed = new Set([...finalNames, ...stagingNames]);
    requireValue((pluginEntries !== null || projectionState === "planned")
      && (!pluginEntries || pluginEntries.every(entry => allowed.has(entry)))
      && (projectionState !== "published" || canonical(pluginEntries) === canonical(finalNames)),
    "E_INSTALL_CONFLICT", "Managed plugin generation contains an unowned plugin path");
  }
  const catalogPath = marketplaceCatalogPath(state.marketplaceRoot, agent);
  if (agent === "claude") {
    const catalogEntries = await names(join(state.marketplaceRoot, ".claude-plugin"));
    if (catalogEntries) requireValue(catalogEntries.every(entry => entry === "marketplace.json")
      && (catalogPresent !== "present" || canonical(catalogEntries) === canonical(["marketplace.json"])),
    "E_INSTALL_CONFLICT", "Managed marketplace directory contains an unowned path");
    requireValue(catalogPresent !== "present" || await exists(catalogPath), "E_INSTALL_CONFLICT", "Managed marketplace catalog is missing");
  } else {
    const agentEntries = await names(join(state.marketplaceRoot, ".agents"));
    if (agentEntries) requireValue(agentEntries.every(entry => entry === "plugins"), "E_INSTALL_CONFLICT", "Managed Codex marketplace directory contains an unowned path");
    const catalogDirEntries = await names(join(state.marketplaceRoot, ".agents", "plugins"));
    if (catalogDirEntries) requireValue(catalogDirEntries.every(entry => entry === "marketplace.json")
      && (catalogPresent !== "present" || canonical(catalogDirEntries) === canonical(["marketplace.json"])),
    "E_INSTALL_CONFLICT", "Managed Codex marketplace catalog directory contains an unowned path");
    requireValue(catalogPresent !== "present" || await exists(catalogPath), "E_INSTALL_CONFLICT", "Managed marketplace catalog is missing");
  }
  for (const plugin of state.plugins) {
    const finalExists = await exists(plugin.expectedPath);
    if (projectionState === "published") await projectionTreeDigest(plugin, agent, configKey(state.configRoot));
    else if (finalExists) await projectionTreeDigest(plugin, agent, configKey(state.configRoot));
  }
};
const removeManagedMarketplace = async (request: PluginRequest, state: PluginState): Promise<void> => {
  const entries = await nativeMarketplaces(request.agent, request.targetHome, request.cwd);
  const matchingName = entries.filter(item => item.name === state.marketplace);
  requireValue(matchingName.length === 0 || matchingName.length === 1 && matchingName[0]!.root === state.marketplaceRoot,
    "E_INSTALL_CONFLICT", "Managed marketplace identity drifted; refusing to remove a different native source", { marketplace: state.marketplace });
  if (matchingName.length === 0) return;
  const remaining = (await nativePlugins(request.agent, request.targetHome, request.cwd))
    .filter(item => item.installed && item.marketplace === state.marketplace);
  requireValue(remaining.length === 0, "E_INSTALL_CONFLICT", "Managed marketplace still has installed plugins; refusing marketplace removal",
    { marketplace: state.marketplace, count: remaining.length });
  const beforeRemove = (await nativeMarketplaces(request.agent, request.targetHome, request.cwd))
    .filter(item => item.name === state.marketplace);
  requireValue(beforeRemove.length === 1 && beforeRemove[0]!.root === state.marketplaceRoot,
    "E_PLAN_STALE", "Managed marketplace changed immediately before removal", { marketplace: state.marketplace });
  await nativeMarketplaceRemove(request.agent, request.targetHome, state.marketplace, request.cwd);
  const afterRemove = (await nativeMarketplaces(request.agent, request.targetHome, request.cwd))
    .some(item => item.name === state.marketplace);
  requireValue(!afterRemove, "E_PLAN_STALE", "Native marketplace remains after removal", { marketplace: state.marketplace });
};
const ownedState = async (request: PluginRequest, key: string): Promise<{ path: string; state: PluginState | null }> => {
  const path = statePath(request.targetHome, key, request.agent);
  const state = await readState(path);
  requireValue(!state || state.configRoot === request.configRoot && state.agent === request.agent,
    "E_INSTALL_CONFLICT", "Plugin state belongs to a different configuration");
  if (state) requireValue(state.marketplace === marketName(request.configRoot, request.agent)
    && state.generation === generationDigest(key, request.agent, state.plugins)
    && state.marketplaceRoot === marketRoot(request.targetHome, key, request.agent, state.generation),
  "E_INSTALL_CONFLICT", "Plugin journal marketplace path does not match this target home and configuration");
  if (state) {
    const projectionRoot = join(state.marketplaceRoot, "plugins");
    requireValue(new Set(state.plugins.map(plugin => plugin.name)).size === state.plugins.length
      && new Set(state.plugins.map(plugin => plugin.id)).size === state.plugins.length
      && state.plugins.every(plugin => !plugin.id.includes("/") && !plugin.id.includes("\\") && plugin.id !== "." && plugin.id !== "..")
      && state.plugins.every(plugin => plugin.expectedPath === join(projectionRoot, plugin.id)
        && (plugin.stagingRoot === undefined || plugin.stagingRoot === projectionStageRoot(plugin))),
    "E_INSTALL_CONFLICT", "Plugin journal contains duplicate identities or an unowned projection path");
    for (const plugin of state.plugins) {
      if (state.stage === "prepared" && !await exists(plugin.expectedPath)) continue;
      await projectionTreeDigest(plugin, request.agent, key);
    }
  }
  return { path, state };
};
const removeOwned = async (request: PluginRequest, path: string, state: PluginState): Promise<void> => {
  await validateMarketplace(state, request);
  state.stage = "removing";
  await writeState(path, state);
  for (let index = 0; index < state.plugins.length; index += 1) {
    const plugin = state.plugins[index]!;
    const current = await currentFingerprint(request, state, plugin);
    if (!current) { state.plugins[index] = { ...plugin, phase: "removed" }; await writeState(path, state); continue; }
    requireValue(plugin.fingerprint && canonical(current) === canonical(plugin.fingerprint), "E_PLAN_STALE",
      "Native plugin no longer matches its recorded ownership fingerprint", { name: plugin.name });
    state.plugins[index] = { ...plugin, phase: "removing" };
    await writeState(path, state);
    const beforeRemove = await currentFingerprint(request, state, plugin);
    requireValue(beforeRemove && canonical(beforeRemove) === canonical(plugin.fingerprint), "E_PLAN_STALE",
      "Native plugin changed immediately before uninstall", { name: plugin.name });
    await nativePluginRemove(request.agent, request.targetHome, plugin.name, state.marketplace, request.cwd);
    requireValue(!await currentFingerprint(request, state, plugin), "E_PLAN_STALE", "Native plugin remains after uninstall", { name: plugin.name });
    state.plugins[index] = { ...plugin, phase: "removed" };
    await writeState(path, state);
  }
  await removeManagedMarketplace(request, state);
  state.stage = "removed";
  await writeState(path, state);
};

const recoverPrepared = async (request: PluginRequest, path: string, state: PluginState): Promise<void> => {
  const context = await config(request);
  requireValue(context.configDigest === state.configDigest, "E_PLAN_STALE", "Configuration changed since plugin projection intent was recorded");
  const bundles = (await readPluginBundles(context)).filter(bundle => !bundle.spec.agents || bundle.spec.agents.includes(request.agent));
  const plans = await Promise.all(bundles.map(bundle => planPluginProjection(bundle, request.agent,
    join(state.marketplaceRoot, "plugins", bundle.id), configKey(state.configRoot))));
  const expected = bundles.map((bundle, index) => ({ id: bundle.id, name: bundle.name, commit: bundle.commit,
    digest: plans[index]!.digest, sourceDigest: bundle.treeDigest, expectedPath: plans[index]!.root, stagingRoot: plans[index]!.stagingRoot }));
  requireValue(state.generation === generationDigest(configKey(state.configRoot), request.agent, expected)
    && canonical(state.plugins.map(({ id, name, commit, digest, sourceDigest, expectedPath }) =>
      ({ id, name, commit, digest, sourceDigest, expectedPath }))) === canonical(expected.map(({ stagingRoot: _stagingRoot, ...plugin }) => plugin))
    && state.plugins.every((plugin, index) => plugin.stagingRoot === undefined || plugin.stagingRoot === plans[index]!.stagingRoot),
  "E_PLAN_STALE", "Current pinned bundles do not match the recorded projection intent");
  await validateGenerationLayout(state, request.agent, "optional", "planned");
  const projections = await Promise.all(plans.map((plan, index) =>
    publishPluginProjection(plan, state.plugins[index]!.stagingRoot ?? plan.stagingRoot)));
  await validateGenerationLayout(state, request.agent, "optional", "published");
  await writeMarketplace(state.marketplaceRoot, state.marketplace, request.agent, bundles);
  await validateGenerationLayout(state, request.agent, "present", "published");
  if (request.agent === "codex") await verifyCodexMarketplaceProjection(state.marketplace, state.marketplaceRoot,
    await codexProbePlugins(bundles, projections));
  const marketplaces = (await nativeMarketplaces(request.agent, request.targetHome, request.cwd))
    .filter(item => item.name === state.marketplace);
  requireValue(marketplaces.length <= 1 && marketplaces.every(item => item.root === state.marketplaceRoot),
    "E_INSTALL_CONFLICT", "Prepared marketplace intent conflicts with a different native marketplace source");
  const names = new Set(state.plugins.map(plugin => plugin.name));
  const installed = (await nativePlugins(request.agent, request.targetHome, request.cwd))
    .filter(plugin => plugin.installed && names.has(plugin.name));
  requireValue(installed.length === 0, "E_INSTALL_CONFLICT",
    "Prepared projection intent has no install ownership fingerprint; recovery will not claim a native installation");
  await validateMarketplace(state, request);
  if (marketplaces.length) await removeManagedMarketplace(request, state);
  state.stage = "recovered";
  await writeState(path, state);
};

const recoverOwned = async (request: PluginRequest, path: string, state: PluginState): Promise<void> => {
  if (state.stage === "prepared") return recoverPrepared(request, path, state);
  await validateMarketplace(state, request);
  for (let index = 0; index < state.plugins.length; index += 1) {
    const plugin = state.plugins[index]!;
    const matches = (await nativePlugins(request.agent, request.targetHome, request.cwd))
      .filter(item => item.name === plugin.name && item.installed);
    if (plugin.phase === "installing" && !plugin.fingerprint) {
      requireValue(matches.length === 0, "E_INSTALL_CONFLICT",
        "Install intent has no native ownership fingerprint; recovery leaves the installed plugin and journal untouched", { name: plugin.name });
      state.plugins[index] = { ...plugin, phase: "removed" };
      await writeState(path, state);
      continue;
    }
    if (plugin.phase === "pending" || plugin.phase === "removed") {
      requireValue(matches.length === 0, "E_INSTALL_CONFLICT", "Recovery found an unowned same-name native plugin and will not remove it", { name: plugin.name });
      state.plugins[index] = { ...plugin, phase: "removed" };
      await writeState(path, state);
      continue;
    }
    const current = await currentFingerprint(request, state, plugin);
    if (!current) { state.plugins[index] = { ...plugin, phase: "removed" }; await writeState(path, state); continue; }
    requireValue(plugin.fingerprint && canonical(current) === canonical(plugin.fingerprint), "E_PLAN_STALE",
      "Recovery fingerprint does not match the current native plugin; leaving it untouched", { name: plugin.name });
    state.plugins[index] = { ...plugin, phase: "removing" };
    await writeState(path, state);
    const beforeRemove = await currentFingerprint(request, state, plugin);
    requireValue(beforeRemove && canonical(beforeRemove) === canonical(plugin.fingerprint), "E_PLAN_STALE",
      "Native plugin changed immediately before recovery uninstall", { name: plugin.name });
    await nativePluginRemove(request.agent, request.targetHome, plugin.name, state.marketplace, request.cwd);
    requireValue(!await currentFingerprint(request, state, plugin), "E_PLAN_STALE", "Native plugin remains after recovery uninstall", { name: plugin.name });
    state.plugins[index] = { ...plugin, phase: "removed" };
    await writeState(path, state);
  }
  await removeManagedMarketplace(request, state);
  // Recovery never changes native trust or authentication settings.
  await writeState(path, { ...state, stage: "recovered" });
};

const rejectDependencies = async (agent: PluginAgent, bundles: readonly PluginBundle[]): Promise<void> => {
  for (const bundle of bundles) {
    const files = await pluginFiles(bundle);
    const path = agent === "claude" ? ".claude-plugin/plugin.json"
      : files.has("plugin.json") ? "plugin.json" : ".codex-plugin/plugin.json";
    const bytes = files.get(path);
    requireValue(bytes, "E_INTEGRITY", `Plugin has no ${agent} manifest`, { plugin: bundle.id });
    let value: unknown;
    try { value = JSON.parse(bytes!.toString("utf8")) as unknown; }
    catch { throw modeError("E_INTEGRITY", "Plugin manifest is invalid", { plugin: bundle.id }); }
    requireValue(value !== null && typeof value === "object" && !Array.isArray(value),
      "E_INTEGRITY", "Plugin manifest is invalid", { plugin: bundle.id, agent });
    const manifest = value as Record<string, unknown>;
    const dependencies = manifest.dependencies;
    requireValue(dependencies === undefined || Array.isArray(dependencies) && dependencies.length === 0,
      "E_PLATFORM", "Plugin dependencies can trigger additional installs; refusing unmanaged side effects", { plugin: bundle.id, agent, manifest: path });
    if (agent === "codex" && path === "plugin.json") {
      const extensions = manifest.extensions;
      const namespace = extensions && typeof extensions === "object" && !Array.isArray(extensions)
        ? (extensions as Record<string, unknown>)["com.openai"] : undefined;
      const extensionDependencies = namespace && typeof namespace === "object" && !Array.isArray(namespace)
        ? (namespace as Record<string, unknown>).dependencies : undefined;
      requireValue(extensionDependencies === undefined || Array.isArray(extensionDependencies) && extensionDependencies.length === 0,
        "E_PLATFORM", "Codex plugin dependencies can trigger additional installs; refusing unmanaged side effects",
        { plugin: bundle.id, agent, manifest: path, field: "extensions.com.openai.dependencies" });
    }
  }
};

const checkConfiguredNamespaces = async (request: PluginRequest, bundles: readonly PluginBundle[]): Promise<void> => {
  const registry = await loadRegistry(registryRoot(request.targetHome));
  const roots = [...new Set(registry?.projects.map(project => project.root) ?? [])].filter(root => root !== request.configRoot);
  const currentNames = new Set(bundles.map(bundle => bundle.name));
  for (const root of roots) {
    const registered = await loadConfig({ configRoot: root });
    if (!Object.keys(registered.config.plugins ?? {}).length) continue;
    const other = (await readPluginBundles(registered)).filter(bundle => !bundle.spec.agents || bundle.spec.agents.includes(request.agent));
    const otherNames = other.map(bundle => bundle.name);
    requireValue(new Set(otherNames).size === otherNames.length, "E_INSTALL_CONFLICT", "A registered configuration contains duplicate native plugin names", { configRoot: root });
    const collision = other.find(bundle => currentNames.has(bundle.name));
    requireValue(!collision, "E_INSTALL_CONFLICT", "Native plugin name is reserved by another registered configuration", {
      name: collision?.name, configRoot: root,
    });
  }
};

const checkMcpNamespaces = async (request: PluginRequest, bundles: readonly PluginBundle[], declarations: readonly (readonly string[])[], ownMarketplace: string): Promise<void> => {
  requireValue(declarations.length === bundles.length, "E_INTEGRITY", "Plugin MCP namespace inventory does not match the configured bundles");
  const owners = new Map<string, string>();
  for (let index = 0; index < declarations.length; index += 1) {
    const plugin = bundles[index]!;
    for (const name of declarations[index]!) {
      const prior = owners.get(name);
      requireValue(!prior, "E_INSTALL_CONFLICT", "Configured plugins declare the same native MCP server name", {
        server: name, plugins: [prior, plugin.id],
      });
      owners.set(name, plugin.id);
    }
  }

  const visibleNative = new Set(await nativeConfiguredMcpNames(request.agent, request.targetHome, request.cwd));
  const installed = await nativePlugins(request.agent, request.targetHome, request.cwd);
  for (const plugin of installed) {
    if (!plugin.installed || !plugin.enabled || plugin.marketplace === ownMarketplace) continue;
    for (const name of await nativeInstalledPluginMcpNames(request.agent, request.targetHome, plugin)) {
      visibleNative.add(name);
    }
  }
  for (const [name, owner] of owners) {
    requireValue(!visibleNative.has(name), "E_INSTALL_CONFLICT", "Native MCP server name is already visible to this agent", {
      server: name, plugin: owner,
    });
  }
};

const apply = async (request: PluginRequest, context: ConfigContext, key: string): Promise<unknown> => {
  const bundles = (await readPluginBundles(context)).filter(bundle => !bundle.spec.agents || bundle.spec.agents.includes(request.agent));
  await rejectDependencies(request.agent, bundles);
  await checkConfiguredNamespaces(request, bundles);
  const names = bundles.map(bundle => bundle.name);
  requireValue(new Set(names).size === names.length, "E_INSTALL_CONFLICT", "Configured plugins share a native plugin name");
  const mcpNames = await Promise.all(bundles.map(bundle => nativePluginMcpNamesAt(request.agent, bundle.root)));
  const { path, state: priorState } = await ownedState(request, key);
  requireValue(!priorState || ["plugin-added", "recovered", "removed"].includes(priorState.stage), "E_BUSY", "An interrupted plugin operation exists; run plugin recover first");
  const name = marketName(request.configRoot, request.agent);
  const bundleIdentities = bundles.map(bundle => ({ id: bundle.id, name: bundle.name, commit: bundle.commit, sourceDigest: bundle.treeDigest }));
  const generation = generationDigest(key, request.agent, bundleIdentities);
  const root = marketRoot(request.targetHome, key, request.agent, generation);
  const state = priorState?.generation === generation ? priorState : null;
  await checkMcpNamespaces(request, bundles, mcpNames, name);
  if (priorState && !state) {
    const oldMarketplace = (await nativeMarketplaces(request.agent, request.targetHome, request.cwd))
      .find(item => item.name === priorState.marketplace);
    requireValue(!oldMarketplace && priorState.stage === "removed", "E_INSTALL_CONFLICT",
      "Remove the previous managed generation before applying a changed plugin pin");
  }
  if (!state) requireValue(!await exists(root), "E_INSTALL_CONFLICT", "Private marketplace generation path exists without a matching ownership journal; refusing to overwrite it", { root });
  if (state) {
    const plans = await Promise.all(bundles.map(bundle => planPluginProjection(bundle, request.agent,
      join(root, "plugins", bundle.id), key)));
    requireValue(state.plugins.every((plugin, index) => plugin.stagingRoot === undefined || plugin.stagingRoot === plans[index]!.stagingRoot),
      "E_PLAN_STALE", "Projection staging paths do not match the recorded journal intent");
    if (state.stage === "prepared") await validateGenerationLayout(state, request.agent, "optional", "planned");
    else await validateGenerationLayout(state, request.agent, "present", "published");
    const projections = await Promise.all(plans.map((plan, index) =>
      publishPluginProjection(plan, state.plugins[index]!.stagingRoot ?? plan.stagingRoot)));
    const unchanged = state.generation === generation && canonical(state.plugins.map(({ id, name: pluginName, commit, digest, sourceDigest, expectedPath }) =>
      ({ id, name: pluginName, commit, digest, sourceDigest, expectedPath }))) === canonical(bundles.map((bundle, index) => ({
      id: bundle.id, name: bundle.name, commit: bundle.commit, digest: projections[index]!.digest, sourceDigest: bundle.treeDigest,
      expectedPath: projections[index]!.root,
    })));
    requireValue(unchanged, "E_PLAN_STALE", "Managed plugin source changed; remove this managed set before applying the new pinned version");
    if (state.stage === "prepared") {
      await validateGenerationLayout(state, request.agent, "optional", "published");
      await writeMarketplace(root, name, request.agent, bundles);
    }
    await validateGenerationLayout(state, request.agent, "present", "published");
    await validateMarketplace(state, request);
    if (request.agent === "codex") await verifyCodexMarketplaceProjection(name, root, await codexProbePlugins(bundles, projections));
    let present = (await nativeMarketplaces(request.agent, request.targetHome, request.cwd)).some(item => item.name === name && item.root === root);
    if (!present) {
      requireValue(!(await nativeMarketplaces(request.agent, request.targetHome, request.cwd)).some(item => item.name === name),
        "E_INSTALL_CONFLICT", "Marketplace name became occupied before registration");
      await nativeMarketplaceAdd(request.agent, request.targetHome, root, request.cwd);
      const after = (await nativeMarketplaces(request.agent, request.targetHome, request.cwd)).filter(item => item.name === name);
      requireValue(after.length === 1 && after[0]!.root === root, "E_PLAN_STALE", "Native marketplace registration did not match the managed source");
      present = true;
    }
    if (state.stage === "plugin-added") {
      for (const plugin of state.plugins) {
        const current = await currentFingerprint(request, state, plugin);
        requireValue(plugin.fingerprint && current && canonical(current) === canonical(plugin.fingerprint), "E_PLAN_STALE",
          "Managed plugin native fingerprint drifted; refusing repair or replacement", { name: plugin.name });
      }
      return result("unchanged", request.agent, name, state.plugins);
    }
    state.stage = "marketplace-added";
    state.plugins = state.plugins.map(plugin => ({ id: plugin.id, name: plugin.name, commit: plugin.commit, digest: plugin.digest,
      sourceDigest: plugin.sourceDigest, expectedPath: plugin.expectedPath,
      ...(plugin.stagingRoot ? { stagingRoot: plugin.stagingRoot } : {}), phase: "pending" }));
    await writeState(path, state);
    for (let index = 0; index < state.plugins.length; index += 1) await installOne(request, path, state, index);
    state.stage = "plugin-added";
    await writeState(path, state);
    return result("applied", request.agent, name, state.plugins);
  }

  const marketEntries = await nativeMarketplaces(request.agent, request.targetHome, request.cwd);
  requireValue(!marketEntries.some(item => item.name === name), "E_INSTALL_CONFLICT", "A marketplace with the modeck name already exists without ownership", { marketplace: name });
  for (const plugin of bundles) await preflightName(request.agent, request.targetHome, plugin.name, name, false, request.cwd);
  requireValue(!(await nativeMarketplaces(request.agent, request.targetHome, request.cwd)).some(item => item.name === name),
    "E_INSTALL_CONFLICT", "Marketplace name became occupied before registration");
  const plans = await Promise.all(bundles.map(bundle => planPluginProjection(bundle, request.agent,
    join(root, "plugins", bundle.id), key)));
  const plugins: ManagedPlugin[] = bundles.map((bundle, index) => ({ id: bundle.id, name: bundle.name,
    commit: bundle.commit, digest: plans[index]!.digest, sourceDigest: bundle.treeDigest,
    expectedPath: plans[index]!.root, stagingRoot: plans[index]!.stagingRoot, phase: "pending" }));
  const journal: PluginState = { version: 3, configRoot: request.configRoot, configDigest: context.configDigest,
    agent: request.agent, generation, marketplace: name, marketplaceRoot: root, stage: "prepared", plugins,
    updatedAt: new Date().toISOString() };
  await writeState(path, journal);
  requireValue(!await exists(root), "E_INSTALL_CONFLICT", "Private marketplace generation appeared after its journal intent; refusing to publish into it", { root });
  const projections = await Promise.all(plans.map((plan, index) =>
    publishPluginProjection(plan, journal.plugins[index]!.stagingRoot ?? plan.stagingRoot)));
  if (journal.plugins.length) await validateGenerationLayout(journal, request.agent, "absent", "published");
  await writeMarketplace(root, name, request.agent, bundles);
  await validateGenerationLayout(journal, request.agent, "present", "published");
  if (request.agent === "codex") await verifyCodexMarketplaceProjection(name, root, await codexProbePlugins(bundles, projections));
  await nativeMarketplaceAdd(request.agent, request.targetHome, root, request.cwd);
  const registered = (await nativeMarketplaces(request.agent, request.targetHome, request.cwd)).filter(item => item.name === name);
  requireValue(registered.length === 1 && registered[0]!.root === root, "E_PLAN_STALE", "Native marketplace registration did not match the managed source");
  journal.stage = "marketplace-added";
  await writeState(path, journal);
  for (let index = 0; index < journal.plugins.length; index += 1) await installOne(request, path, journal, index);
  journal.stage = "plugin-added";
  await writeState(path, journal);
  return result("applied", request.agent, name, plugins);
};

const installOne = async (request: PluginRequest, path: string, state: PluginState, index: number): Promise<void> => {
  const plugin = state.plugins[index]!;
  await preflightName(request.agent, request.targetHome, plugin.name, state.marketplace, true, request.cwd);
  state.plugins[index] = { ...plugin, phase: "installing" };
  await writeState(path, state);
  await preflightName(request.agent, request.targetHome, plugin.name, state.marketplace, true, request.cwd);
  const installPath = await nativePluginAdd(request.agent, request.targetHome, plugin.name, state.marketplace, request.cwd);
  const fingerprint = await currentFingerprint(request, state, plugin, installPath);
  if (!fingerprint) throw modeError("E_PLATFORM", "Native install completed but plugin inventory cannot prove its source and contents", { name: plugin.name });
  state.plugins[index] = { ...plugin, phase: "installed", fingerprint };
  await writeState(path, state);
};

const result = (outcome: string, agent: PluginAgent, marketplace: string, plugins: readonly ManagedPlugin[]): unknown => ({ outcome, agent, marketplace, plugins,
    concurrency: "Native CLI operations are checked before and verified after each command; the CLI does not provide compare-and-swap semantics.",
    session: "Restart the agent session to load plugin changes.", trust: "Native hook or plugin trust prompts remain under agent control.",
    auth: "Native user_config is scoped to plugin@marketplace; settings from existing installations are not migrated.",
    observability: agent === "claude"
      ? "plugin list --json reports identity, version, scope, enabled state, install path and source folder; plugin details exposes declared components, not proof each hook, MCP server, agent, or command ran."
      : "Before target changes, an isolated temporary Codex home installs the private marketplace and checks plugin/read MCP names, hook events and empty skills plus hooks/list event visibility. This proves loader visibility, not hook trust or execution; target trust is never modified." });

export const managePlugins = async (action: Action, request: PluginRequest): Promise<unknown> => {
  const home = await nativeHome(request);
  const root = await safeAbsolute(request.configRoot);
  const normalized = { ...request, configRoot: root };
  const key = configKey(root);
  if (action === "init") {
    const context = await config(normalized);
    const bundles = await initPluginBundles(context);
    return { outcome: "initialized", plugins: bundles.map(({ id, name, commit, treeDigest, dynamic }) => ({ id, name, commit, digest: treeDigest, dynamic: dynamic.length })) };
  }
  if (action === "status") {
    const context = await config(normalized);
    const { state } = await ownedState(normalized, key);
    const bundles = (await readPluginBundles(context)).filter(bundle => !bundle.spec.agents || bundle.spec.agents.includes(request.agent));
    const nativeRoot = join(home, request.agent === "claude" ? ".claude" : ".codex");
    const installed = await exists(nativeRoot) ? await nativePlugins(request.agent, home, request.cwd) : [];
    return { outcome: "status", agent: request.agent, ownership: state?.stage ?? "unmanaged",
      plugins: bundles.map(bundle => ({ id: bundle.id, name: bundle.name, commit: bundle.commit,
        installed: installed.some(item => item.name === bundle.name && item.marketplace === state?.marketplace && item.installed) })) };
  }
  return withPluginMutex(request.agent, async () => {
    const { path, state } = await ownedState(normalized, key);
    if (action === "recover") {
      if (!state) throw modeError("E_RESOURCE_MISSING", "No interrupted plugin operation is recorded");
      if (state.stage === "plugin-added") throw modeError("E_CONFIG", "No interrupted operation is pending; managed plugins are installed");
      if (state.stage === "recovered" || state.stage === "removed") {
        await validateMarketplace(state, normalized);
        await removeManagedMarketplace(normalized, state);
        return { outcome: state.stage === "removed" ? "already-removed" : "already-recovered", marketplace: state.marketplace };
      }
      await recoverOwned(normalized, path, state);
      return { outcome: "recovered", removed: state.plugins.filter(plugin => plugin.phase === "removed").length,
        marketplace: state.marketplace, preserved: ["native trust", "authentication settings", "private marketplace source files"] };
    }
    if (action === "remove") {
      if (!state || !["plugin-added", "recovered", "removed"].includes(state.stage)) throw modeError("E_RESOURCE_MISSING", "This configuration has no managed native plugin installation");
      if (state.stage === "removed") {
        await validateMarketplace(state, normalized);
        await removeManagedMarketplace(normalized, state);
        return { outcome: "already-removed", agent: request.agent, plugins: state.plugins.length };
      }
      await removeOwned(normalized, path, state);
      return { outcome: "removed", agent: request.agent, plugins: state.plugins.length,
        session: "Restart the agent session to finish unloading plugin changes." };
    }
    if (action === "apply") return apply(normalized, await config(normalized), key);
    throw modeError("E_USAGE", "Unknown plugin operation");
  });
};
