import { resolve } from "node:path";
import { modeError } from "../contracts/index.js";
import { findConfigPath } from "../core/config-file.js";
import { loadRecord } from "../integration/install.js";
import { safeAbsolute } from "../integration/fs.js";

export const configRootFor = async (home: string, cwd: string, explicit?: string): Promise<string> => {
  if (explicit !== undefined) return safeAbsolute(resolve(explicit));
  const records = await Promise.all((["claude", "codex", "codebuddy"] as const).map(agent => loadRecord(home, agent)));
  const roots = [...new Set(records.flatMap(record => record ? [record.configRoot] : []))];
  if (roots.length > 1) throw modeError("E_CONFIG", "Bindings reference different repositories; specify --config <dir>");
  // A binding is the user's trusted choice; business cwd must not shadow it with executable JavaScript.
  if (roots[0]) return safeAbsolute(roots[0]);
  const root = await safeAbsolute(resolve(cwd));
  if (await findConfigPath(root)) return root;
  throw modeError("E_CONFIG", "No modup configuration found; use --config <dir>, or run modup init in a configuration directory and modup bind --agent <agent> there");
};
