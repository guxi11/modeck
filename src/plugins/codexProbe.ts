import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { LIMITS, modeError } from "../contracts/index.js";
import { safeAbsolute } from "../integration/fs.js";
import { regularBytes, removeTemporary, utf8 } from "../resources/fs.js";
import { nativePluginAdd, nativeMarketplaceAdd } from "./native.js";

type ProbePlugin = Readonly<{ name: string; expectedPath: string; components: readonly string[];
  expectedMcp: readonly string[]; expectedHooks: readonly string[] }>;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as JsonObject : null;
const exists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
};
const normalizedEvent = (value: string): string => value.replace(/[^a-z0-9]/giu, "").toLowerCase();
const exactSet = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && new Set(actual).size === actual.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);

const jsonAt = async (root: string, path: string): Promise<unknown> => {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw modeError("E_INTEGRITY", "Codex plugin hook declaration escapes its projection");
  }
  await safeAbsolute(target);
  return JSON.parse(utf8((await regularBytes(target, LIMITS.manifestBytes)).bytes)) as unknown;
};

const rejectUnverifiedApps = async (root: string): Promise<void> => {
  for (const path of ["plugin.json", ".codex-plugin/plugin.json"]) {
    const filePath = join(root, path);
    if (!await exists(filePath)) continue;
    const manifest = object(await jsonAt(root, path));
    const extension = object(object(manifest?.extensions)?.["com.openai"]);
    if (manifest?.apps !== undefined && !(Array.isArray(manifest.apps) && manifest.apps.length === 0)
      || extension?.apps !== undefined && !(Array.isArray(extension.apps) && extension.apps.length === 0)
      || await exists(join(root, ".app.json"))) {
      throw modeError("E_INTEGRITY", "Codex plugin apps cannot be proven equivalent by the isolated loader check");
    }
  }
};

const appServer = async <T>(home: string, cwd: string, requests: readonly Readonly<{ method: string; params: JsonObject }>[]): Promise<T[]> => {
  const env: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: join(home, ".codex") };
  for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const child = spawn("codex", ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 1;
  let buffer = "";
  let ended = false;
  child.stdout.setEncoding("utf8");
  child.stderr.resume();
  child.stdin.on("error", () => undefined);
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) {
      child.kill("SIGKILL");
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message: JsonObject;
      try {
        const parsed: unknown = JSON.parse(line) as unknown;
        const parsedObject = object(parsed);
        if (!parsedObject) continue;
        message = parsedObject;
      } catch { continue; }
      if (typeof message.id !== "number") continue;
      const callback = pending.get(message.id);
      if (!callback) continue;
      pending.delete(message.id);
      if (message.error) callback.reject(new Error("Codex app-server rejected component verification"));
      else callback.resolve(message.result);
    }
  });
  child.once("error", () => {
    ended = true;
    for (const callback of pending.values()) callback.reject(new Error("Codex app-server could not start"));
    pending.clear();
  });
  child.once("close", () => {
    ended = true;
    for (const callback of pending.values()) callback.reject(new Error("Codex app-server exited during component verification"));
    pending.clear();
  });
  const request = (method: string, params: JsonObject): Promise<unknown> => new Promise((resolveRequest, rejectRequest) => {
    if (ended) { rejectRequest(new Error("Codex app-server is unavailable")); return; }
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error("Codex app-server component verification timed out"));
    }, 30_000);
    pending.set(id, {
      resolve: value => { clearTimeout(timeout); resolveRequest(value); },
      reject: error => { clearTimeout(timeout); rejectRequest(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, error => {
      if (!error) return;
      pending.delete(id);
      clearTimeout(timeout);
      rejectRequest(new Error("Codex app-server request failed"));
    });
  });
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolveStop => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolveStop(); }, 2_000);
      child.once("close", () => { clearTimeout(timer); resolveStop(); });
      child.kill("SIGTERM");
    });
  };
  try {
    await request("initialize", { clientInfo: { name: "modeck-plugin-preflight", version: "1.0.0" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
    const results: T[] = [];
    for (const item of requests) results.push(await request(item.method, item.params) as T);
    return results;
  } catch {
    throw modeError("E_PLATFORM", "Codex isolated app-server could not verify projected plugin components");
  } finally { await stop(); }
};

const assertPluginRead = (raw: unknown, plugin: ProbePlugin, marketplace: string, marketplacePath: string,
  expectedMcp: readonly string[], expectedHooks: readonly string[]): void => {
  const response = object(raw);
  const detail = object(response?.plugin);
  const summary = object(detail?.summary);
  if (!detail || !summary || summary.installed !== true || summary.enabled !== true || summary.id !== `${plugin.name}@${marketplace}`
    || detail.marketplacePath !== marketplacePath) {
    throw modeError("E_INTEGRITY", "Codex isolated loader did not report the projected plugin as installed and enabled", { plugin: plugin.name });
  }
  const mcp = detail.mcpServers;
  const hooks = detail.hooks;
  const skills = detail.skills;
  const apps = detail.apps;
  const appTemplates = detail.appTemplates;
  const mcpNames = Array.isArray(mcp) && mcp.every(name => typeof name === "string") ? mcp as string[] : null;
  const hookEvents = Array.isArray(hooks) && hooks.every(item => typeof object(item)?.eventName === "string")
    ? [...new Set((hooks as JsonObject[]).map(item => normalizedEvent(item.eventName as string)))].sort() : null;
  const checks = { mcpMatched: Boolean(mcpNames && exactSet(mcpNames, expectedMcp)),
    hooksMatched: Boolean(hookEvents && exactSet(hookEvents, expectedHooks)), skillsEmpty: Array.isArray(skills) && skills.length === 0,
    appsEmpty: Array.isArray(apps) && apps.length === 0, appTemplatesEmpty: Array.isArray(appTemplates) && appTemplates.length === 0,
    onboardingSkillEmpty: detail.onboardingSkill === null || detail.onboardingSkill === undefined };
  if (Object.values(checks).some(check => !check)) {
    throw modeError("E_INTEGRITY", "Codex isolated loader silently omitted or changed projected MCP, hook, or skill components", { plugin: plugin.name, checks });
  }
};

const assertHookList = (raw: unknown, plugin: ProbePlugin, marketplace: string, cwd: string, expected: readonly string[]): void => {
  const response = object(raw);
  if (!Array.isArray(response?.data)) throw modeError("E_PLATFORM", "Codex hooks/list returned an unsupported response");
  const entry = response.data.map(object).find(item => item?.cwd === cwd);
  if (!entry || !Array.isArray(entry.hooks)) throw modeError("E_INTEGRITY", "Codex hooks/list omitted the isolated working directory");
  if (Array.isArray(entry.errors) && entry.errors.length > 0 || Array.isArray(entry.warnings) && entry.warnings.length > 0) {
    throw modeError("E_INTEGRITY", "Codex hooks/list reported plugin hook loading warnings or errors");
  }
  const pluginId = `${plugin.name}@${marketplace}`;
  const actual: string[] = [];
  for (const hook of entry.hooks) {
    const row = object(hook);
    if (row?.pluginId !== pluginId) continue;
    if (typeof row.eventName !== "string") throw modeError("E_INTEGRITY", "Codex hooks/list returned a malformed plugin hook");
    actual.push(normalizedEvent(row.eventName));
  }
  const actualEvents = [...new Set(actual)].sort();
  if (!exactSet(actualEvents, expected)) {
    throw modeError("E_INTEGRITY", "Codex hooks/list did not expose the expected plugin hook events", { plugin: plugin.name });
  }
};

export const verifyCodexMarketplaceProjection = async (marketplace: string, marketplaceRoot: string,
  plugins: readonly ProbePlugin[]): Promise<void> => {
  const tempRoot = await mkdtemp(join(await realpath(tmpdir()), "modeck-codex-loader-check-"));
  const home = join(tempRoot, "home");
  try {
    await chmod(tempRoot, 0o700);
    await mkdir(join(home, ".codex"), { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    await chmod(join(home, ".codex"), 0o700);
    for (const plugin of plugins) {
      await rejectUnverifiedApps(plugin.expectedPath);
      if (plugin.components.some(component => component !== "mcpServers" && component !== "hooks")) {
        throw modeError("E_INTEGRITY", "Codex projection contains a component outside the verified MCP and hook loaders", { plugin: plugin.name });
      }
    }
    try { await nativeMarketplaceAdd("codex", home, marketplaceRoot); }
    catch { throw modeError("E_PLATFORM", "Codex isolated marketplace registration failed"); }
    for (const plugin of plugins) {
      try { await nativePluginAdd("codex", home, plugin.name, marketplace); }
      catch { throw modeError("E_PLATFORM", "Codex isolated plugin installation failed", { plugin: plugin.name }); }
    }

    const marketplaceFile = join(marketplaceRoot, ".agents", "plugins", "marketplace.json");
    await safeAbsolute(marketplaceFile);
    const responses = await appServer(home, tempRoot, [
      ...plugins.map(plugin => ({ method: "plugin/read", params: { pluginName: plugin.name, marketplacePath: marketplaceFile } })),
      { method: "hooks/list", params: { cwds: [tempRoot] } },
    ]);
    const hookResponse = responses[responses.length - 1];
    for (let index = 0; index < plugins.length; index += 1) {
      const plugin = plugins[index]!;
      assertPluginRead(responses[index], plugin, marketplace, marketplaceFile, plugin.expectedMcp, plugin.expectedHooks);
      assertHookList(hookResponse, plugin, marketplace, tempRoot, plugin.expectedHooks);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && String(error.code).startsWith("E_")) throw error;
    throw modeError("E_PLATFORM", "Codex isolated native installation could not verify the private plugin marketplace");
  } finally {
    const stat = await lstat(tempRoot).catch(() => null);
    if (stat?.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.()) {
      await removeTemporary(tempRoot);
    }
  }
};
