import { isAbsolute } from "node:path";
import { agentDefinitions, isAgent, LIMITS, modeError } from "../contracts/index.js";
import type { Agent, EncodeHookRequest, HookEvent, HookReply } from "../contracts/index.js";
import { object } from "./fs.js";

export const encodeHook = ({ rendered }: EncodeHookRequest): HookReply => {
  const adapter = agentDefinitions[rendered.agent].hook;
  return adapter.output === "additionalContext" ? { additionalContext: rendered.text }
    : { hookSpecificOutput: { hookEventName: adapter.event, additionalContext: rendered.text } };
};
export const parseEvent = (value: unknown, agent?: Agent): HookEvent => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw modeError("E_HOOK_INPUT", "Invalid SessionStart event");
  }
  const raw = object(value);
  const adapter = agentDefinitions[agent ?? "claude"];
  const cwd = raw.cwd;
  const sessionId = adapter.hook.input === "copilot" ? raw.sessionId : raw.session_id;
  const eventName = adapter.hook.input === "copilot" ? adapter.hook.event : raw.hook_event_name;
  const resolvedCwd = adapter.hook.cwdFallback && cwd === undefined ? process.cwd() : cwd;
  if (eventName !== adapter.hook.event || typeof resolvedCwd !== "string" || !isAbsolute(resolvedCwd)
    || typeof sessionId !== "string" || !sessionId || sessionId.length > LIMITS.sessionIdChars
    || /\p{Cc}/u.test(sessionId) || typeof raw.source !== "string"
    || !(adapter.hook.sources as readonly string[]).includes(raw.source)) {
    throw modeError("E_HOOK_INPUT", "Invalid SessionStart event");
  }
  return { hook_event_name: "SessionStart", cwd: resolvedCwd, session_id: sessionId, source: raw.source };
};
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export const hookGroup = (agent: Agent, cli: string, configRoot: string, stateRoot: string, node = process.execPath) => {
  const adapter = agentDefinitions[agent].hook;
  return {
    ...(adapter.matcher ? { matcher: `^(${adapter.sources.join("|")})$` } : {}),
    hooks: [{ type: "command", command: [node, cli, "hook", "--agent", agent,
      "--config", configRoot, "--state", stateRoot].map(quote).join(" "),
    timeout: LIMITS.hookTimeoutSeconds, ...adapter.commandOptions }],
  };
};

const hooksAt = (root: Record<string, unknown>, agent: Agent): Record<string, unknown> => {
  const adapter = agentDefinitions[agent].hook;
  if (adapter.nativeContainer === "events") return root;
  return root.hooks === undefined ? {} : object(root.hooks);
};
export const readHookGroups = (root: Record<string, unknown>, agent: Agent): readonly unknown[] => {
  const adapter = agentDefinitions[agent].hook;
  const hooks = hooksAt(root, agent);
  const entries = hooks[adapter.event] ?? [];
  if (!Array.isArray(entries)) throw modeError("E_INSTALL_CONFLICT", "Invalid SessionStart settings");
  if (adapter.nativeEntries === "groups") return entries;
  return entries.map(item => {
    const entry = object(item);
    if (entry.type !== undefined && entry.type !== "command") return { hooks: [entry] };
    const { timeoutSec, timeout, ...handler } = entry;
    return { ...(typeof entry.matcher === "string" ? { matcher: entry.matcher } : {}),
      hooks: [{ ...handler, type: "command", ...((timeoutSec ?? timeout) === undefined ? {} : { timeout: timeoutSec ?? timeout }) }] };
  });
};
export const writeHookGroups = (root: Record<string, unknown>, groups: readonly unknown[], agent: Agent,
  beforeRoot?: Record<string, unknown>): Record<string, unknown> => {
  const adapter = agentDefinitions[agent].hook;
  const current = hooksAt(root, agent);
  const previous = beforeRoot ? hooksAt(beforeRoot, agent) : {};
  const entries = adapter.nativeEntries === "groups" ? groups : groups.flatMap(item => {
    const group = object(item);
    if (!Array.isArray(group.hooks)) return [];
    return group.hooks.map(value => {
      const handler = object(value);
      const { timeout, ...rest } = handler;
      return { ...rest, ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
        ...(timeout === undefined ? {} : { [adapter.timeoutField]: timeout }) };
    });
  });
  const nextHooks = entries.length || Object.hasOwn(previous, adapter.event)
    ? { ...current, [adapter.event]: entries }
    : Object.fromEntries(Object.entries(current).filter(([key]) => key !== adapter.event));
  if (adapter.nativeContainer === "events") return nextHooks;
  const nextRoot = adapter.nativeContainer === "versioned-hooks" ? { ...root, version: 1 } : root;
  if (!Object.keys(nextHooks).length && !beforeRoot?.hooks && adapter.nativeContainer === "hooks") {
    return Object.fromEntries(Object.entries(nextRoot).filter(([key]) => key !== "hooks"));
  }
  return { ...nextRoot, hooks: nextHooks };
};
