import { isAbsolute } from "node:path";
import { agentDefinitions, isAgent, LIMITS, modeError } from "../contracts/index.js";
import type { Agent, EncodeHookRequest, HookEvent, HookReply } from "../contracts/index.js";
import { object } from "./fs.js";

export const encodeHook = ({ rendered }: EncodeHookRequest): HookReply =>
  ({ hookSpecificOutput: { hookEventName: agentDefinitions[rendered.agent].hook.event, additionalContext: rendered.text } });
export const parseEvent = (value: unknown, agent?: Agent): HookEvent => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw modeError("E_HOOK_INPUT", "Invalid SessionStart event");
  }
  const raw = object(value);
  const adapter = agentDefinitions[agent ?? "claude"];
  const event = adapter.hook.cwdFallback && raw.cwd === undefined ? { ...raw, cwd: process.cwd() } : raw;
  if (event.hook_event_name !== adapter.hook.event || typeof event.cwd !== "string" || !isAbsolute(event.cwd)
    || typeof event.session_id !== "string" || !event.session_id || event.session_id.length > LIMITS.sessionIdChars
    || /\p{Cc}/u.test(event.session_id) || typeof event.source !== "string"
    || !(adapter.hook.sources as readonly string[]).includes(event.source)) {
    throw modeError("E_HOOK_INPUT", "Invalid SessionStart event");
  }
  return { hook_event_name: "SessionStart", cwd: event.cwd, session_id: event.session_id, source: event.source as HookEvent["source"] };
};
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export const hookGroup = (agent: Agent, cli: string, configRoot: string, stateRoot: string, node = process.execPath) => ({
  matcher: `^(${agentDefinitions[agent].hook.sources.join("|")})$`,
  hooks: [{ type: "command", command: [node, cli, "hook", "--agent", agent,
    "--config", configRoot, "--state", stateRoot].map(quote).join(" "), timeout: LIMITS.hookTimeoutSeconds,
  ...agentDefinitions[agent].hook.commandOptions }],
});
