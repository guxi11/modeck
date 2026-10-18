import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonical, modeError, parseJson, sha256 } from "../contracts/index.js";
import type { PluginAgent } from "../contracts/index.js";
import { safeAbsolute } from "../integration/fs.js";
import { withMcpMutex } from "../mcp/mutex.js";

export type NativeFingerprint = { name: string; marketplace: string; installed: true; enabled: boolean;
  scope: string; version: string | null; installPath: string; sourcePath: string; marketplacePath: string; contentDigest: string; sourceDigest: string };
export type ManagedPlugin = { id: string; name: string; commit: string; digest: string; sourceDigest: string; expectedPath: string;
  phase: "pending" | "installing" | "installed" | "removing" | "removed"; stagingRoot?: string; fingerprint?: NativeFingerprint };
export type PluginState = { version: 3; configRoot: string; configDigest: string; agent: PluginAgent; generation: string; marketplace: string;
  marketplaceRoot: string; stage: "prepared" | "marketplace-added" | "plugin-added" | "removing" | "recovered" | "removed";
  plugins: ManagedPlugin[]; updatedAt: string };

export const pluginsRoot = (home: string): string => join(home, ".local", "share", "modeck", "plugins");
export const statePath = (home: string, configHash: string, agent: PluginAgent): string =>
  join(pluginsRoot(home), configHash, agent, "state.json");
export const configKey = (configRoot: string): string => sha256(Buffer.from(configRoot));

export const withPluginMutex = async <T>(agent: PluginAgent, operation: () => Promise<T>): Promise<T> => {
  try {
    // The virtual key is intentionally independent of HOME; withMcpMutex maps its canonical identity to a permanent kernel-locked inode.
    const domain = join(await realpath("/tmp"),
      `modeck-native-plugin-domain-${process.getuid?.() ?? "unknown"}`, agent);
    return await withMcpMutex([domain], operation);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "E_BUSY") {
      throw modeError("E_BUSY", "Another native plugin lifecycle operation is running", { agent });
    }
    if (error instanceof Error && error.message.startsWith("MCP requires working nonblocking kernel file locks")) {
      throw modeError("E_PLATFORM", "Native plugin management requires working nonblocking kernel file locks; no unlocked fallback is used");
    }
    throw error;
  }
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  canonical(Object.keys(value).sort()) === canonical([...keys].sort());
const fingerprint = (value: unknown): value is NativeFingerprint => record(value)
  && keysAre(value, ["name", "marketplace", "installed", "enabled", "scope", "version", "installPath", "sourcePath", "marketplacePath", "contentDigest", "sourceDigest"])
  && typeof value.name === "string" && typeof value.marketplace === "string" && value.installed === true
  && typeof value.enabled === "boolean" && value.scope === "user" && (value.version === null || typeof value.version === "string")
  && typeof value.installPath === "string" && typeof value.sourcePath === "string"
  && typeof value.marketplacePath === "string" && /^[a-f0-9]{64}$/u.test(String(value.contentDigest))
  && /^[a-f0-9]{64}$/u.test(String(value.sourceDigest));
const managed = (value: unknown): value is ManagedPlugin => record(value)
  && keysAre(value, ["id", "name", "commit", "digest", "sourceDigest", "expectedPath", "phase",
    ...(value.stagingRoot === undefined ? [] : ["stagingRoot"]), ...(value.fingerprint === undefined ? [] : ["fingerprint"])])
  && typeof value.id === "string" && typeof value.name === "string" && /^[a-f0-9]{40}$/u.test(String(value.commit))
  && /^[a-f0-9]{64}$/u.test(String(value.digest))
  && /^[a-f0-9]{64}$/u.test(String(value.sourceDigest)) && typeof value.expectedPath === "string"
  && (value.stagingRoot === undefined || typeof value.stagingRoot === "string")
  && ["pending", "installing", "installed", "removing", "removed"].includes(String(value.phase))
  && (value.fingerprint === undefined || fingerprint(value.fingerprint))
  && (value.phase !== "installed" && value.phase !== "removing" || value.fingerprint !== undefined)
  && (value.phase !== "installing" || value.fingerprint === undefined);
const validate = (value: unknown): PluginState => {
  if (!record(value) || !keysAre(value, ["version", "configRoot", "configDigest", "agent", "generation", "marketplace", "marketplaceRoot", "stage", "plugins", "updatedAt"])
    || value.version !== 3 || !["claude", "codex"].includes(String(value.agent)) || !/^[a-f0-9]{64}$/u.test(String(value.generation))
    || !["prepared", "marketplace-added", "plugin-added", "removing", "recovered", "removed"].includes(String(value.stage))
    || typeof value.configRoot !== "string" || !/^[a-f0-9]{64}$/u.test(String(value.configDigest)) || typeof value.marketplace !== "string"
    || typeof value.marketplaceRoot !== "string" || !Array.isArray(value.plugins) || value.plugins.length > 4096 || !value.plugins.every(managed)
    || typeof value.updatedAt !== "string") {
    throw modeError("E_INTEGRITY", "Plugin ownership journal is malformed or uses an unsupported schema");
  }
  return value as unknown as PluginState;
};

export const readState = async (path: string): Promise<PluginState | null> => {
  await safeAbsolute(path);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
      || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > 1024 * 1024) {
      throw modeError("E_INSTALL_CONFLICT", "Plugin ownership journal must be a private, singly linked regular file owned by this user");
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      const current = await lstat(path);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1 || opened.uid !== process.getuid?.()
        || (opened.mode & 0o777) !== 0o600 || current.dev !== opened.dev || current.ino !== opened.ino) {
        throw modeError("E_INSTALL_CONFLICT", "Plugin ownership journal changed while being read");
      }
      return validate(parseJson((await handle.readFile()).toString("utf8")));
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
};

export const writeState = async (path: string, state: PluginState): Promise<void> => {
  await safeAbsolute(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const dir = await lstat(dirname(path));
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0) {
    throw modeError("E_INSTALL_CONFLICT", "Plugin journal directory must be private and cannot be a symlink");
  }
  const existing = await lstat(path).catch(error => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== process.getuid?.()
    || (existing.mode & 0o777) !== 0o600 || existing.nlink !== 1)) {
    throw modeError("E_INSTALL_CONFLICT", "Refusing to replace an unsafe plugin ownership journal");
  }
  const temporary = join(dirname(path), `.state-${process.pid}-${Date.now()}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
};

export const removeState = async (path: string): Promise<void> => {
  await safeAbsolute(path);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.uid !== process.getuid?.()) {
    throw modeError("E_INSTALL_CONFLICT", "Refusing to remove a changed plugin ownership journal");
  }
  await rm(path);
};
