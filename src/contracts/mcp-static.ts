export type StaticMcpAgent = "claude" | "codex";
export type StaticMcpScope = "user" | "project";
export type StaticMcpReference = Readonly<{ env: string }>;
export type StaticMcpServer = Readonly<{
  transport: "stdio"; command: string; args?: readonly string[];
  env?: Readonly<Record<string, StaticMcpReference>>;
} | {
  transport: "http" | "sse"; url: string;
  headers?: Readonly<Record<string, StaticMcpReference>>;
}>;
export type StaticMcpConfig = Readonly<{ schemaVersion: 1; servers: Readonly<Record<string, StaticMcpServer>> }>;
export type StaticMcpRequest = Readonly<{
  agent: StaticMcpAgent; scope: StaticMcpScope; targetHome: string; cwd: string; configRoot: string;
}>;
export type StaticMcpDecision = Readonly<{ name: string; action: "added" | "updated" | "matched" | "preserved" | "rejected"; reason: string }>;
export type StaticMcpSummary = Readonly<{
  action: string; outcome: "success" | "partial" | "failed"; agent: string; scope: string;
  counts: Readonly<Record<StaticMcpDecision["action"], number>>; decisions: readonly StaticMcpDecision[];
  message: string; next: string; target?: string; configuration?: string;
}>;
