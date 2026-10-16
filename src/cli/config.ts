import { resolve } from "node:path";
import { modeError } from "../contracts/index.js";
import { findConfigPath } from "../core/config-file.js";
import { loadRecord } from "../integration/install.js";
import { safeAbsolute } from "../integration/fs.js";
import { configRoots, loadRegistry, registryRoot } from "../integration/registry.js";

export const configRootFor = async (home: string, cwd: string, explicit?: string): Promise<string> => {
  if (explicit !== undefined) return safeAbsolute(resolve(explicit));
  const registry = await safeAbsolute(registryRoot(home));
  if (await loadRegistry(registry)) return registry;
  const records = await Promise.all((["claude", "codex", "codebuddy"] as const).map(agent => loadRecord(home, agent)));
  const roots = [...new Set(records.flatMap(record => record ? [record.configRoot] : []))];
  if (roots.length > 1) throw modeError("E_CONFIG", "Bindings reference different repositories; specify --config <dir>");
  // A binding is the user's trusted choice; business cwd must not shadow it with executable JavaScript.
  if (roots[0]) return safeAbsolute(roots[0]);
  const root = await safeAbsolute(resolve(cwd));
  if (await findConfigPath(root)) return root;
  throw modeError("E_CONFIG", "No modup configuration found; use --config <dir>, or initialize and register a configuration directory, then run modup config");
};

export const projectRootFor = async (home: string, cwd: string, explicit?: string): Promise<string> => {
  const root = await configRootFor(home, cwd, explicit);
  const roots = await configRoots(root);
  if (roots.length !== 1) throw modeError("E_CONFIG", "Select one configuration project with --config <dir>", { roots });
  return roots[0]!;
};
