import { relative, isAbsolute } from "node:path";
import { collectFacts, compile, loadConfig, parseLock, resolve } from "../core/index.js";
import { readResources } from "../resources/index.js";
import { modeError } from "../contracts/index.js";
import type { PrepareRequest, PreparedContext, VerifiedResourceSet } from "../contracts/index.js";
import { safeAbsolute } from "./fs.js";
import { nativeSkillNames } from "./codebuddy.js";

export const prepare = async ({ configRoot, stateRoot, cwd, agent }: PrepareRequest): Promise<PreparedContext> => {
  const state = await safeAbsolute(stateRoot);
  const facts = await collectFacts({ cwd, stateRoot: state });
  const context = await loadConfig({ configRoot: await safeAbsolute(configRoot), facts });
  const rel = relative(context.configRoot, state);
  if (rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")) throw modeError("E_PATH", "State must be outside the configuration repository");
  // Selection precedes I/O so unrelated unavailable resources cannot block a mode.
  const selection = resolve({ context, facts, lockDigest: "0".repeat(64) });
  const resources: VerifiedResourceSet = await readResources({ context, stateRoot: state, parseLock,
    resourceIds: selection.resources.map(resource => resource.id) });
  const plan = resolve({ context, facts, lockDigest: resources.lockDigest });
  return { plan, rendered: compile({ plan, resources, agent,
    ...(agent === "codebuddy" ? { nativeSkillNames: await nativeSkillNames(cwd) } : {}) }) };
};
