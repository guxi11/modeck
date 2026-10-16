import { lstat } from "node:fs/promises";
import { join, relative } from "node:path";
import { canonical, LIMITS, modeError, sha256 } from "../contracts/index.js";
import type { Config, ConfigContext, LoadConfigRequest } from "../contracts/index.js";
import { exists, missing, regularBytes } from "../resources/fs.js";
import { safePath } from "./files.js";
import { findConfigPath, readConfigFile } from "./config-file.js";
import { automaticModes } from "./auto.js";
import { parseConfig } from "./validation.js";
import { compare, immutable } from "./values.js";

type Source = { readonly path: string; readonly digest: string };
export const configIdentity = (root: string, config: Config, sources?: readonly Source[]): string =>
  sha256(Buffer.from(canonical(sources ? { config,
    sources: sources.map(source => ({ path: relative(root, source.path).split("\\").join("/"), digest: source.digest })) } : config)));

export const validateConfig = async (context: ConfigContext): Promise<void> => {
  const sources = context.configSources ?? [{ path: join(context.configRoot, "modup.yaml"), digest: context.rawConfigDigest }];
  await Promise.all(sources.map(async source => {
    const { bytes } = await regularBytes(source.path, LIMITS.fileBytes);
    if (sha256(bytes) !== source.digest) throw modeError("E_CONFIG", "Configuration or imported plugin changed after loading", { path: source.path });
  }));
  if (configIdentity(context.configRoot, context.config, context.configSources) !== context.configDigest) {
    throw modeError("E_CONFIG", "Loaded configuration identity changed");
  }
};

export const loadConfig = async ({ configRoot, facts }: LoadConfigRequest): Promise<ConfigContext> => {
  try {
    const root = await safePath(configRoot);
    if (!(await lstat(root)).isDirectory()) throw modeError("E_PATH", "Config root must be a directory", { path: root });
    const configPath = await findConfigPath(root);
    if (!configPath) throw modeError("E_CONFIG", "Configuration file is missing; specify --config <dir> containing modup.yaml or modup.yml, or run modup init in that directory", { path: configPath });
    const { bytes } = await regularBytes(configPath, LIMITS.jsonBytes);
    const loaded = await readConfigFile(configPath);
    const autoPath = join(root, "modep-auto.mjs");
    const selection = await exists(autoPath) ? await automaticModes(autoPath, facts) : undefined;
    const config = parseConfig(loaded.config);
    if (Object.hasOwn(config.modes, "auto")) throw modeError("E_CONFIG", "auto is reserved for automatic mode selection");
    if (selection?.invalidAuto || selection?.autoModeIds !== undefined && (!Array.isArray(selection?.autoModeIds)
      || selection?.autoModeIds.length > LIMITS.modes || selection?.autoModeIds.some(id => typeof id !== "string" || !Object.hasOwn(config.modes, id)))) {
      throw modeError("E_CONFIG", "auto must return an array of known mode IDs");
    }
    const configSources = [...loaded.sources, ...(selection?.sources ?? [])].sort((a, b) => compare(a.path, b.path));
    if (!configSources.some(source => source.path === configPath && source.digest === sha256(bytes))) {
      throw modeError("E_CONFIG", "Configuration changed while loading");
    }
    const context = immutable({ configRoot: root, config,
      configDigest: configIdentity(root, config, configSources), rawConfigDigest: sha256(bytes), configSources,
      ...(selection?.autoModeIds !== undefined ? { autoModeIds: [...new Set(selection?.autoModeIds as string[])] } : {}) });
    await validateConfig(context);
    return context;
  } catch (error) {
    if (missing(error)) throw modeError("E_CONFIG", "Configuration directory is unavailable; restore it or specify --config <dir> containing modup.yaml or modup.yml", { path: configRoot });
    if (error instanceof Error && "code" in error && String(error.code).startsWith("E_")) throw error;
    throw modeError("E_CONFIG", "Cannot load configuration", { path: configRoot, cause: String(error) });
  }
};
