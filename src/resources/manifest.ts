import { validateConfig } from "../core/config.js";
import type { ConfigContext } from "../contracts/index.js";
import { requireValue, safePath, within } from "./fs.js";

export const validateContext = async (context: ConfigContext, stateRoot: string): Promise<void> => {
  const root = await safePath(context.configRoot);
  const state = await safePath(stateRoot, true);
  requireValue(!within(root, state), "E_PATH", "State must be outside the shared config directory");
  await validateConfig(context);
};
