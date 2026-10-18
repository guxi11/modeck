import type { DeepReadonly, PluginAgent, PluginSpec, Sha256, TreeEntry } from "./types.js";

export type PluginDynamic = DeepReadonly<{ id: string; kind: "skill" | "rule"; path: string; agents?: PluginAgent[] }>;
export type PluginBundle = DeepReadonly<{ id: string; name: string; root: string; commit: string; treeDigest: string;
  entries: TreeEntry[]; dynamic: PluginDynamic[]; spec: PluginSpec }>;
export type PluginProjection = DeepReadonly<{ id: string; name: string; root: string; digest: string; components: string[] }>;
export type PluginRequest = DeepReadonly<{ configRoot: string; targetHome: string; agent: PluginAgent; cwd: string }>;
