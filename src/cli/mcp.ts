import { isAgent, isMcpAgent, modeError } from "../contracts/index.js";
import type { McpAgent, McpRequest } from "../contracts/index.js";
import { fileURLToPath } from "node:url";
import { prepareMcp } from "../integration/prepare.js";
import { applyMcpPlan, mcpStatus, planMcp, renderMcpServers } from "../integration/mcp.js";
import { applyBindPlan, loadRecord, planBind } from "../integration/install.js";
import { digest } from "../integration/fs.js";

export const manageMcp = async ({ action, agent, configRoot, stateRoot, cwd, targetHome, scope, expectDigest }: Readonly<{
  action: string; agent: McpAgent; configRoot: string; stateRoot: string; cwd: string; targetHome: string;
  scope?: string; expectDigest?: string;
}>): Promise<unknown> => {
  if (!["render", "plan", "apply", "status"].includes(action)) throw modeError("E_USAGE", "Expected mcp render, plan, apply or status");
  if (!isMcpAgent(agent)) throw modeError("E_USAGE", "Unknown MCP agent");
  if (action !== "render" && !isAgent(agent)) throw modeError("E_USAGE", "This MCP agent supports render only");
  if (scope !== undefined && scope !== "user" && scope !== "project") throw modeError("E_USAGE", "MCP scope must be user or project");
  if (action === "apply" && (!expectDigest || !/^[a-f0-9]{64}$/.test(expectDigest))) {
    throw modeError("E_USAGE", "MCP apply requires --expect <plan digest>");
  }
  const mcp = await prepareMcp({ configRoot, stateRoot, cwd });
  if (action === "render") return { agent, servers: await renderMcpServers(agent, mcp.servers), provenance: mcp.provenance };
  if (!isAgent(agent)) throw modeError("E_USAGE", "This MCP agent supports render only");
  const record = await loadRecord(targetHome, agent);
  const nativeScope = scope ?? record?.mcp?.scope ?? (agent === "codex" ? "user" : "project");
  if (record && (action === "plan" || action === "apply")) {
    if (record.configRoot !== configRoot || record.stateRoot !== stateRoot) {
      throw modeError("E_CONFIG", "A bound agent must synchronize its bound configuration and state; use modeck config to change them");
    }
    const plan = await planBind({ agent, targetHome, configRoot, stateRoot, cwd, scope: nativeScope,
      runtimeRoot: fileURLToPath(new URL("../../", import.meta.url)) });
    if (action === "apply") {
      await applyBindPlan({ plan, ...(expectDigest === undefined ? {} : { expectDigest }) });
      return { agent, applied: true, planDigest: plan.planDigest, restartRequired: true, toolsVisible: "unknown", approval: "native", warnings: plan.warnings };
    }
    return { ...plan, changes: plan.changes.map(({ after, ...change }) => ({ ...change,
      afterDigest: after ? digest(after) : null, afterMode: after?.mode ?? null })),
      ...(plan.mcp ? { mcp: { ...plan.mcp, changes: plan.mcp.changes.map(({ after, ...change }) => ({ ...change,
        afterDigest: after ? digest(after) : null, afterMode: after?.mode ?? null })) } } : {}) };
  }
  const request: McpRequest = { agent, targetHome, cwd, desired: mcp.servers, configDigest: mcp.configDigest,
    provenance: mcp.provenance, scope: nativeScope };
  if (action === "status") return mcpStatus(request);
  const plan = await planMcp(request);
  if (action === "plan") return plan;
  await applyMcpPlan({ plan, ...(expectDigest === undefined ? {} : { expectDigest }) });
  return { agent, applied: true, planDigest: plan.planDigest, restartRequired: true, toolsVisible: "unknown", approval: "native", warnings: plan.warnings };
};
