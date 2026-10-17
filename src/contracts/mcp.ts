import type { Agent, Diagnostic, McpProvenance, McpServer } from "./types.js";
import { agents } from "./agents.js";

export type McpAgent = Agent | "cursor" | "copilot" | "opencode";
export const mcpAgents: readonly McpAgent[] = Object.freeze([...agents, "cursor", "copilot", "opencode"]);
export const isMcpAgent = (value: unknown): value is McpAgent => typeof value === "string" && mcpAgents.some(agent => agent === value);

export type McpServers = Readonly<Record<string, McpServer>>;
export type McpScope = "user" | "project";
export type McpLocationRequest = Readonly<{ agent: Agent; targetHome: string; cwd: string; scope?: McpScope }>;
export type McpPlanRequest = McpLocationRequest & Readonly<{ desired: McpServers; configDigest: string;
  provenance?: readonly McpProvenance[] }>;
export type McpRequest = McpPlanRequest;
export type McpDecision = Readonly<{ name: string; action: "add" | "update" | "remove" | "keep" | "conflict";
  ownerAgent: Agent | null; ownedDigest: string | null; currentDigest: string | null; desiredDigest: string | null }>;
export type McpObservation = Readonly<{ path: string; digest: string | null; mode: number | null }>;
export type McpPlan = Readonly<{ schemaVersion: 1; owner: "modeck/mcp/1"; request: McpPlanRequest;
  targetPath: string; recordPath: string; observations: readonly McpObservation[];
  servers: readonly McpDecision[]; conflicts: readonly Diagnostic[]; warnings: readonly Diagnostic[]; planDigest: string }>;
export type McpApplyRequest = Readonly<{ plan: McpPlan; expectDigest?: string }>;
export type McpStatus = Readonly<{ schemaVersion: 1; agent: Agent; targetPath: string; configDigest: string;
  provenance: readonly McpProvenance[];
  servers: readonly McpDecision[]; conflicts: readonly Diagnostic[]; warnings: readonly Diagnostic[];
  configuration: "conflict" | "matches" | "changes-required"; policy: "unknown";
  connection: "unknown"; tools: "unknown"; approval: "unknown" }>;
