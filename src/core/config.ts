import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { canonical, LIMITS, modeError, sha256 } from "../contracts/index.js";
import type { ConfigContext, LoadConfigRequest } from "../contracts/index.js";
import { safePath } from "./files.js";
import { readJsonFile } from "./files.js";
import { parseConfig } from "./validation.js";
import { immutable } from "./values.js";

export const loadConfig = async ({ configRoot }: LoadConfigRequest): Promise<ConfigContext> => {
  try {
    const root = await safePath(configRoot);
    if (!(await lstat(root)).isDirectory()) throw modeError("E_PATH", "Config root must be a directory", { path: root });
    const { value, bytes } = await readJsonFile(join(root, "modes.json"), LIMITS.jsonBytes, "E_CONFIG");
    const config = parseConfig(value);
    return immutable({ configRoot: root, config, configDigest: sha256(Buffer.from(canonical(config))),
      rawConfigDigest: sha256(bytes) });
  } catch (error) {
    if (error instanceof Error && "code" in error && String(error.code).startsWith("E_")) throw error;
    throw modeError("E_CONFIG", "Cannot load configuration", { path: configRoot, cause: String(error) });
  }
};
