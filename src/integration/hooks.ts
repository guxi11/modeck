import { isAbsolute } from "node:path";
import { canonical, LIMITS, modeError, parseJson } from "../contracts/index.js";
import type { Agent, EncodeHookRequest, HookEvent, HookReply, RunMarker } from "../contracts/index.js";
import { object } from "./fs.js";

export const encodeHook = ({ event, rendered, marker, configRoot, stateRoot }: EncodeHookRequest): HookReply => {
  if (marker) {
    if (marker.version !== 1 || marker.agent !== rendered.agent || marker.cwd !== event.cwd
      || marker.configRoot !== configRoot || marker.stateRoot !== stateRoot || marker.contentDigest !== rendered.contentDigest) {
      throw modeError("E_WRAPPER_CONFLICT", "Wrapper and hook context differ");
    }
    return null;
  }
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: rendered.text } };
};
export const parseEvent = (value: unknown): HookEvent => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw modeError("E_HOOK_INPUT", "Invalid SessionStart event");
  }
  const event = object(value);
  if (event.hook_event_name !== "SessionStart" || typeof event.cwd !== "string" || !isAbsolute(event.cwd)
    || typeof event.session_id !== "string" || !event.session_id || event.session_id.length > LIMITS.sessionIdChars
    || /\p{Cc}/u.test(event.session_id) || typeof event.source !== "string"
    || !["startup", "resume", "clear", "compact", "fork"].includes(event.source)) {
    throw modeError("E_HOOK_INPUT", "Invalid SessionStart event");
  }
  return { hook_event_name: "SessionStart", cwd: event.cwd, session_id: event.session_id, source: event.source as HookEvent["source"] };
};
export const runMarker = (): RunMarker | null => {
  const raw = process.env.MODUP_RUN_V1;
  if (raw === undefined) return null;
  try {
    const marker = object(parseJson(raw));
    if (marker.version !== 1 || typeof marker.agent !== "string" || !["codex", "claude"].includes(marker.agent)
      || !["cwd", "configRoot", "stateRoot"].every(key => {
        const path = marker[key];
        return typeof path === "string" && path.startsWith("/");
      })
      || typeof marker.contentDigest !== "string" || !/^[0-9a-f]{64}$/.test(marker.contentDigest)
      || typeof marker.ownerPid !== "number" || !Number.isSafeInteger(marker.ownerPid) || marker.ownerPid <= 0) throw new Error("Invalid marker");
    process.kill(marker.ownerPid, 0);
    return marker as unknown as RunMarker;
  } catch { throw modeError("E_WRAPPER_CONFLICT", "Invalid or expired wrapper marker"); }
};
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export const hookGroup = (agent: Agent, cli: string, configRoot: string, stateRoot: string, node = process.execPath) => ({
  matcher: "^(startup|resume|clear|compact|fork)$",
  hooks: [{ type: "command", command: [node, cli, "hook", "--agent", agent,
    "--config", configRoot, "--state", stateRoot].map(quote).join(" "), timeout: LIMITS.hookTimeoutSeconds,
  ...(agent === "codex" ? { additionalContextLimit: 0 } : {}) }],
});
export const markerText = (marker: RunMarker): string => canonical(marker);
