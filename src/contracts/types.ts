export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T
  : T extends Uint8Array ? Readonly<Uint8Array>
  : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export type Id = DeepReadonly<string>;
export type Sha256 = DeepReadonly<string>;
export type Agent = DeepReadonly<"codex" | "claude" | "codebuddy">;
export type Kind = DeepReadonly<"rule" | "skill">;
export type Source = DeepReadonly<{ type: "local"; path: string }
  | { type: "git"; url: string; ref: string; path: string }>;
export type ResourceSpec = DeepReadonly<{ kind: Kind; source: Source }>;
export type Mode = DeepReadonly<{ extends: Id[]; rules: Id[]; skills: Id[] }>;
export type Config = DeepReadonly<{ defaults: Id[]; modes: Record<Id, Mode>; resources: Record<Id, ResourceSpec> }>;
export type Selector = DeepReadonly<{ auto: boolean; add: Id[] }>;
export type TreeEntry = DeepReadonly<{ path: string; kind: "directory" }
  | { path: string; kind: "file"; digest: Sha256; bytes: number; executable: boolean }>;
export type ManifestResource = DeepReadonly<{ id: Id; kind: Kind; sourceDigest: Sha256; commit: string | null; treeDigest: Sha256; entries: TreeEntry[] }>;
export type ResourceManifest = DeepReadonly<{ schemaVersion: 1; resourceSpecDigest: Sha256; resources: ManifestResource[] }>;
export type ConfigContext = DeepReadonly<{ configRoot: string; config: Config; configDigest: Sha256; rawConfigDigest: Sha256;
  configSources?: { path: string; digest: Sha256 }[]; autoModeIds?: Id[] }>;
export type ProjectFacts = DeepReadonly<{ cwd: string; boundary: string; files: string[]; dependencies: string[]; selector: { path: string; value: Selector } | null }>;
export type Reason = DeepReadonly<{ mode: Id; via: "default" | "detect" | "selector" | "parent"; from: Id | null; conditionIndex: number | null }>;
export type Diagnostic = DeepReadonly<{ code: string; message: string; path: string | null }>;
export type BoundResource = DeepReadonly<{ id: Id; kind: Kind }>;
export type ResolvedPlan = DeepReadonly<{ schemaVersion: 1; configDigest: Sha256; resourceDigest: Sha256; cwd: string; boundary: string; selectorPath: string | null; modeIds: Id[]; resources: BoundResource[]; reasons: Reason[]; diagnostics: Diagnostic[] }>;
export type VerifiedResource = DeepReadonly<{ id: Id; kind: Kind; treeDigest: Sha256; root: string; entry: string; entryBytes: Uint8Array; skill: { name: string; description: string } | null }>;
export type VerifiedResourceSet = DeepReadonly<{ schemaVersion: 1; configDigest: Sha256; manifest: ResourceManifest; resourceDigest: Sha256; resources: VerifiedResource[] }>;
export type RenderedContext = DeepReadonly<{ schemaVersion: 1; protocol: "modup-context/1"; agent: Agent; configDigest: Sha256; resourceDigest: Sha256; selectionDigest: Sha256; modeIds: Id[]; text: string; contentDigest: Sha256; byteLength: number }>;
export type HookEvent = DeepReadonly<{ hook_event_name: "SessionStart"; cwd: string; session_id: string; source: "startup" | "resume" | "clear" | "compact" | "fork" }>;
export type HookReply = DeepReadonly<{ hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string } } | null>;
export type RunMarker = DeepReadonly<{ version: 1; agent: Agent; configRoot: string; stateRoot: string; cwd: string; contentDigest: Sha256; ownerPid: number }>;
export type FileImage = DeepReadonly<{ data: string; encoding: "utf8" | "base64"; mode: number }>;
export type FileChange = DeepReadonly<{ path: string; category: "shared-json" | "owned"; beforeDigest: Sha256 | null; beforeMode: number | null; after: FileImage | null }>;
export type BindPlan = DeepReadonly<{ schemaVersion: 1; operation: "bind" | "unbind"; agent: Agent; targetHome: string; owner: "modup/v1"; changes: FileChange[]; conflicts: Diagnostic[]; warnings: Diagnostic[]; planDigest: Sha256 }>;
export type ManagedFile = DeepReadonly<{ path: string; digest: Sha256; mode: number }>;
export type BindRecord = DeepReadonly<{ schemaVersion: 1; owner: "modup/v1"; agent: Agent; configRoot: string; stateRoot: string; runtimeDigest: Sha256; files: ManagedFile[]; hookFile: string; hookGroup: unknown; beforeHookFile: FileImage | null; afterHookFileDigest: Sha256 }>;
export type ManifestParser = DeepReadonly<(value: unknown) => ResourceManifest>;
export type LoadConfigRequest = DeepReadonly<{ configRoot: string; facts?: ProjectFacts }>;
export type CollectFactsRequest = DeepReadonly<{ cwd: string; stateRoot: string }>;
export type ResolveRequest = DeepReadonly<{ context: ConfigContext; facts: ProjectFacts; resourceDigest: Sha256 }>;
export type CompileRequest = DeepReadonly<{ plan: ResolvedPlan; resources: VerifiedResourceSet; agent: Agent; nativeSkillNames?: string[] }>;
export type SyncMode = DeepReadonly<"reuse" | "update">;
export type ReadResourcesRequest = DeepReadonly<{ context: ConfigContext; stateRoot: string; parseManifest: ManifestParser; resourceIds?: Id[] }>;
export type SyncResourcesRequest = DeepReadonly<ReadResourcesRequest & { mode: SyncMode }>;
export type PrepareRequest = DeepReadonly<{ configRoot: string; stateRoot: string; cwd: string; agent: Agent }>;
export type PreparedContext = DeepReadonly<{ plan: ResolvedPlan; rendered: RenderedContext }>;
export type EncodeHookRequest = DeepReadonly<{ event: HookEvent; rendered: RenderedContext; marker: RunMarker | null; configRoot: string; stateRoot: string }>;
export type PlanBindRequest = DeepReadonly<{ agent: Agent; targetHome: string; configRoot: string; stateRoot: string; runtimeRoot: string }>;
export type PlanUnbindRequest = DeepReadonly<{ agent: Agent; targetHome: string }>;
export type ApplyBindPlanRequest = DeepReadonly<{ plan: BindPlan; expectDigest?: Sha256 }>;
export type RunAgentRequest = DeepReadonly<PrepareRequest & { argv: string[]; executable: string }>;
export type RunResult = DeepReadonly<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
export type ModeErrorCode = DeepReadonly<"E_CONFIG" | "E_SELECTOR" | "E_MODE_CONFLICT" | "E_SCAN_LIMIT"
  | "E_PATH" | "E_MANIFEST_MISSING" | "E_MANIFEST_MISMATCH" | "E_RESOURCE_MISSING"
  | "E_INTEGRITY" | "E_GIT" | "E_GIT_COMMIT_UNAVAILABLE" | "E_LIMIT" | "E_CONTEXT_SIZE"
  | "E_INSTALL_CONFLICT" | "E_PLAN_STALE" | "E_BUSY" | "E_WRAPPER_CONFLICT"
  | "E_CODEX_CONFIG" | "E_HOOK_INPUT" | "E_PLATFORM" | "E_USAGE" | "E_IO">;
export type ModeError = DeepReadonly<Error & { code: ModeErrorCode; details: Readonly<Record<string, unknown>> }>;
