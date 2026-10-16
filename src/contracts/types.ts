export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T
  : T extends Uint8Array ? Readonly<Uint8Array>
  : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export type Id = DeepReadonly<string>;
export type Sha256 = DeepReadonly<string>;
export type Agent = DeepReadonly<"codex" | "claude">;
export type Kind = DeepReadonly<"rule" | "skill">;
export type Source = DeepReadonly<{ type: "local"; path: string }
  | { type: "git"; url: string; ref: string; path: string }>;
export type ResourceSpec = DeepReadonly<{ kind: Kind; source: Source }>;
export type Condition = DeepReadonly<{ type: "exists"; path: string }
  | { type: "glob"; pattern: string } | { type: "dependency"; name: string }>;
export type SkillBinding = DeepReadonly<{ id: Id; preload: boolean }>;
export type Mode = DeepReadonly<{ extends: Id[]; priority: number; detect?: { any: Condition[] }; rules: Id[]; skills: SkillBinding[] }>;
export type Config = DeepReadonly<{ schemaVersion: 1; defaults: Id[]; modes: Record<Id, Mode>; resources: Record<Id, ResourceSpec> }>;
export type Selector = DeepReadonly<{ schemaVersion: 1; auto: boolean; add: Id[]; disable: Id[] }>;
export type TreeEntry = DeepReadonly<{ path: string; kind: "directory" }
  | { path: string; kind: "file"; digest: Sha256; bytes: number; executable: boolean }>;
export type LockedResource = DeepReadonly<{ id: Id; kind: Kind; sourceDigest: Sha256; commit: string | null; treeDigest: Sha256; entries: TreeEntry[] }>;
export type ResourceLock = DeepReadonly<{ schemaVersion: 1; resourceSpecDigest: Sha256; resources: LockedResource[] }>;
export type ConfigContext = DeepReadonly<{ configRoot: string; config: Config; configDigest: Sha256; rawConfigDigest: Sha256;
  configSources?: { path: string; digest: Sha256 }[]; autoModeIds?: Id[] }>;
export type ProjectFacts = DeepReadonly<{ cwd: string; boundary: string; files: string[]; dependencies: string[]; selector: { path: string; value: Selector } | null }>;
export type Reason = DeepReadonly<{ mode: Id; via: "default" | "detect" | "selector" | "parent"; from: Id | null; conditionIndex: number | null }>;
export type Diagnostic = DeepReadonly<{ code: string; message: string; path: string | null }>;
export type BoundResource = DeepReadonly<{ id: Id; kind: Kind; preload: boolean }>;
export type ResolvedPlan = DeepReadonly<{ schemaVersion: 1; configDigest: Sha256; lockDigest: Sha256; cwd: string; boundary: string; selectorPath: string | null; modeIds: Id[]; resources: BoundResource[]; reasons: Reason[]; diagnostics: Diagnostic[] }>;
export type VerifiedResource = DeepReadonly<{ id: Id; kind: Kind; treeDigest: Sha256; root: string; entry: string; entryBytes: Uint8Array; skill: { name: string; description: string; body: string } | null }>;
export type VerifiedResourceSet = DeepReadonly<{ schemaVersion: 1; configDigest: Sha256; lock: ResourceLock; lockDigest: Sha256; resources: VerifiedResource[] }>;
export type RenderedContext = DeepReadonly<{ schemaVersion: 1; protocol: "modup-context/1"; agent: Agent; configDigest: Sha256; lockDigest: Sha256; selectionDigest: Sha256; modeIds: Id[]; text: string; contentDigest: Sha256; byteLength: number }>;
export type HookEvent = DeepReadonly<{ hook_event_name: "SessionStart"; cwd: string; session_id: string; source: "startup" | "resume" | "clear" | "compact" | "fork" }>;
export type HookReply = DeepReadonly<{ hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string } } | null>;
export type RunMarker = DeepReadonly<{ version: 1; agent: Agent; configRoot: string; stateRoot: string; cwd: string; contentDigest: Sha256; ownerPid: number }>;
export type FileImage = DeepReadonly<{ data: string; encoding: "utf8" | "base64"; mode: number }>;
export type FileChange = DeepReadonly<{ path: string; category: "shared-json" | "owned"; beforeDigest: Sha256 | null; beforeMode: number | null; after: FileImage | null }>;
export type InstallPlan = DeepReadonly<{ schemaVersion: 1; operation: "install" | "uninstall"; agent: Agent; targetHome: string; owner: "modup/v1"; changes: FileChange[]; conflicts: Diagnostic[]; warnings: Diagnostic[]; planDigest: Sha256 }>;
export type ManagedFile = DeepReadonly<{ path: string; digest: Sha256; mode: number }>;
export type InstallRecord = DeepReadonly<{ schemaVersion: 1; owner: "modup/v1"; agent: Agent; configRoot: string; stateRoot: string; runtimeDigest: Sha256; files: ManagedFile[]; hookFile: string; hookGroup: unknown; beforeHookFile: FileImage | null; afterHookFileDigest: Sha256 }>;
export type LockParser = DeepReadonly<(value: unknown) => ResourceLock>;
export type ImportValidator = DeepReadonly<(stagingRoot: string) => Promise<void>>;
export type LoadConfigRequest = DeepReadonly<{ configRoot: string; facts?: ProjectFacts }>;
export type CollectFactsRequest = DeepReadonly<{ cwd: string; stateRoot: string }>;
export type ResolveRequest = DeepReadonly<{ context: ConfigContext; facts: ProjectFacts; lockDigest: Sha256 }>;
export type CompileRequest = DeepReadonly<{ plan: ResolvedPlan; resources: VerifiedResourceSet; agent: Agent }>;
export type InitConfigRequest = DeepReadonly<{ destination: string; initialConfig: Config }>;
export type ImportConfigRequest = DeepReadonly<{ url: string; ref: string; destination: string; validate: ImportValidator }>;
export type SyncMode = DeepReadonly<"reuse" | "update" | "frozen">;
export type ReadResourcesRequest = DeepReadonly<{ context: ConfigContext; stateRoot: string; parseLock: LockParser; resourceIds?: Id[] }>;
export type SyncResourcesRequest = DeepReadonly<ReadResourcesRequest & { mode: SyncMode }>;
export type PrepareRequest = DeepReadonly<{ configRoot: string; stateRoot: string; cwd: string; agent: Agent }>;
export type PreparedContext = DeepReadonly<{ plan: ResolvedPlan; rendered: RenderedContext }>;
export type EncodeHookRequest = DeepReadonly<{ event: HookEvent; rendered: RenderedContext; marker: RunMarker | null; configRoot: string; stateRoot: string }>;
export type PlanInstallRequest = DeepReadonly<{ agent: Agent; targetHome: string; configRoot: string; stateRoot: string; runtimeRoot: string }>;
export type PlanUninstallRequest = DeepReadonly<{ agent: Agent; targetHome: string }>;
export type ApplyInstallPlanRequest = DeepReadonly<{ plan: InstallPlan; expectDigest?: Sha256 }>;
export type RunAgentRequest = DeepReadonly<PrepareRequest & { argv: string[]; executable: string }>;
export type RunResult = DeepReadonly<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
export type ModeErrorCode = DeepReadonly<"E_CONFIG" | "E_SELECTOR" | "E_MODE_CONFLICT" | "E_SCAN_LIMIT"
  | "E_PATH" | "E_LOCK_MISSING" | "E_LOCK_MISMATCH" | "E_RESOURCE_MISSING"
  | "E_INTEGRITY" | "E_GIT" | "E_GIT_COMMIT_UNAVAILABLE" | "E_LIMIT" | "E_CONTEXT_SIZE"
  | "E_INSTALL_CONFLICT" | "E_PLAN_STALE" | "E_BUSY" | "E_WRAPPER_CONFLICT"
  | "E_CODEX_CONFIG" | "E_HOOK_INPUT" | "E_PLATFORM" | "E_USAGE" | "E_IO">;
export type ModeError = DeepReadonly<Error & { code: ModeErrorCode; details: Readonly<Record<string, unknown>> }>;
