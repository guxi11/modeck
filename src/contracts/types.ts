export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T
  : T extends Uint8Array ? Readonly<Uint8Array>
  : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export type Id = DeepReadonly<string>;
export type Sha256 = DeepReadonly<string>;
export type Agent = DeepReadonly<import("./agents.js").AgentId>;
export type Kind = DeepReadonly<"rule" | "skill">;
export type PluginAgent = DeepReadonly<"claude" | "codex">;
export type PluginSpec = DeepReadonly<{ source: { url: string; commit: string; path?: string }; agents?: PluginAgent[] }>;
export type Source = DeepReadonly<{ type: "local"; path: string }
  | { type: "use"; url: string; path: string }>;
export type ResourceSpec = DeepReadonly<{ kind: Kind; source: Source }>;
export type Mode = DeepReadonly<{ extends: Id[]; rules: Id[]; skills: Id[]; plugins: Id[] }>;
export type Config = DeepReadonly<{ defaults: Id[]; modes: Record<Id, Mode>; resources: Record<Id, ResourceSpec>; plugins: Record<Id, PluginSpec> }>;
export type ConfigRegistry = DeepReadonly<{ schemaVersion: 1; projects: { root: string; enabled: boolean }[] }>;
export type Selector = DeepReadonly<{ auto: boolean; add: Id[] }>;
export type TreeEntry = DeepReadonly<{ path: string; kind: "directory" }
  | { path: string; kind: "file"; digest: Sha256; bytes: number; executable: boolean }>;
export type ManifestResource = DeepReadonly<{ id: Id; kind: Kind; sourceDigest: Sha256; commit: string | null; treeDigest: Sha256; entries: TreeEntry[] }>;
export type ResourceManifest = DeepReadonly<{ schemaVersion: 1; resourceSpecDigest: Sha256; resources: ManifestResource[] }>;
export type ConfigContext = DeepReadonly<{ configRoot: string; config: Config; configDigest: Sha256; rawConfigDigest: Sha256;
  configSources?: { path: string; digest: Sha256 }[]; autoModeIds?: Id[] }>;
export type ProjectFacts = DeepReadonly<{ cwd: string; boundary: string; files: string[]; dependencies: string[]; selector: { path: string; value: Selector } | null; excluded: { path: string; reason: string }[] }>;
export type Reason = DeepReadonly<{ mode: Id; via: "default" | "detect" | "selector" | "parent"; from: Id | null; conditionIndex: number | null }>;
export type Diagnostic = DeepReadonly<{ code: string; message: string; path: string | null }>;
export type BoundResource = DeepReadonly<{ id: Id; kind: Kind }>;
export type ResolvedPlan = DeepReadonly<{ schemaVersion: 1; configDigest: Sha256; resourceDigest: Sha256; cwd: string; boundary: string; selectorPath: string | null; modeIds: Id[]; pluginIds: Id[]; resources: BoundResource[]; reasons: Reason[]; diagnostics: Diagnostic[] }>;
export type VerifiedResource = DeepReadonly<{ id: Id; kind: Kind; treeDigest: Sha256; root: string; entry: string; entryBytes: Uint8Array; skill: { name: string; description: string } | null }>;
export type VerifiedResourceSet = DeepReadonly<{ schemaVersion: 1; configDigest: Sha256; manifest: ResourceManifest; resourceDigest: Sha256; resources: VerifiedResource[] }>;
export type FilteredResource = DeepReadonly<{ id: Id; kind: Kind; basis: "native-skill" | "native-instruction" }>;
export type RenderedContext = DeepReadonly<{ schemaVersion: 1; protocol: "modeck-context/1"; agent: Agent; configDigest: Sha256; resourceDigest: Sha256; selectionDigest: Sha256; modeIds: Id[]; text: string; contentDigest: Sha256; byteLength: number; filtered: FilteredResource[] }>;
export type HookEvent = DeepReadonly<{ hook_event_name: "SessionStart"; cwd: string; session_id: string; source: string }>;
export type HookReply = DeepReadonly<{ hookSpecificOutput: { hookEventName: string; additionalContext: string } } | { additionalContext: string }>;
export type FileImage = DeepReadonly<{ data: string; encoding: "utf8" | "base64"; mode: number }>;
export type FileChange = DeepReadonly<{ path: string; category: "shared-json" | "owned"; beforeDigest: Sha256 | null; beforeMode: number | null; after: FileImage | null }>;
export type BindPlan = DeepReadonly<{ schemaVersion: 1; operation: "bind" | "unbind"; agent: Agent; targetHome: string; owner: "modeck/v1"; changes: FileChange[]; conflicts: Diagnostic[]; warnings: Diagnostic[]; planDigest: Sha256 }>;
export type ManagedFile = DeepReadonly<{ path: string; digest: Sha256; mode: number }>;
export type BindRecord = DeepReadonly<{ schemaVersion: 1; owner: "modeck/v1"; agent: Agent; configRoot: string; stateRoot: string; runtimeDigest: Sha256; files: ManagedFile[]; hookFile: string; hookGroup: unknown; beforeHookFile: FileImage | null; afterHookFileDigest: Sha256 }>;
export type ManifestParser = DeepReadonly<(value: unknown) => ResourceManifest>;
export type LoadConfigRequest = DeepReadonly<{ configRoot: string; facts?: ProjectFacts }>;
export type CollectFactsRequest = DeepReadonly<{ cwd: string; stateRoot: string; ignoreSelector?: boolean }>;
export type ResolveRequest = DeepReadonly<{ context: ConfigContext; facts: ProjectFacts; resourceDigest: Sha256 }>;
export type CompileRequest = DeepReadonly<{ plan: ResolvedPlan; resources: VerifiedResourceSet; agent: Agent; nativeSkillNames?: string[]; nativeInstructions?: string[] }>;
export type ReadResourcesRequest = DeepReadonly<{ context: ConfigContext; stateRoot: string; parseManifest: ManifestParser; resourceIds?: Id[] }>;
export type PrepareRequest = DeepReadonly<{ configRoot: string; configRoots?: string[]; stateRoot: string; cwd: string; agent: Agent }>;
export type PreparedContext = DeepReadonly<{ plan: ResolvedPlan; rendered: RenderedContext }>;
export type EncodeHookRequest = DeepReadonly<{ rendered: RenderedContext }>;
export type PlanBindRequest = DeepReadonly<{ agent: Agent; targetHome: string; configRoot: string; configRoots?: string[]; stateRoot: string; runtimeRoot: string }>;
export type PlanUnbindRequest = DeepReadonly<{ agent: Agent; targetHome: string }>;
export type ApplyBindPlanRequest = DeepReadonly<{ plan: BindPlan; expectDigest?: Sha256 }>;
export type ModeErrorCode = DeepReadonly<"E_CONFIG" | "E_SELECTOR" | "E_MODE_CONFLICT" | "E_SCAN_LIMIT"
  | "E_PATH" | "E_MANIFEST_MISSING" | "E_MANIFEST_MISMATCH" | "E_RESOURCE_MISSING"
  | "E_INTEGRITY" | "E_GIT" | "E_GIT_COMMIT_UNAVAILABLE" | "E_LIMIT" | "E_CONTEXT_SIZE"
  | "E_INSTALL_CONFLICT" | "E_PLAN_STALE" | "E_BUSY"
  | "E_HOOK_INPUT" | "E_PLATFORM" | "E_USAGE" | "E_IO">;
export type ModeError = DeepReadonly<Error & { code: ModeErrorCode; details: Readonly<Record<string, unknown>> }>;
