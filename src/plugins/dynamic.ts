import { parseDocument } from "yaml";
import { canonical, LIMITS, modeError, sha256 } from "../contracts/index.js";
import type { Agent, ConfigContext, PluginAgent, ResolvedPlan, VerifiedResource, VerifiedResourceSet } from "../contracts/index.js";
import { publishObject } from "../resources/store.js";
import { resourceEntry, validateNames } from "../resources/skill.js";
import { fromFiles } from "../resources/tree.js";
import type { FileData, Snapshot } from "../resources/tree.js";
import { pluginFiles, readPluginBundles } from "./bundle.js";

const digest = (value: unknown): string => sha256(Buffer.from(canonical(value)));
const dynamicSkillIdentity = new WeakMap<VerifiedResource, string>();
export const sameDynamicSkillContent = (left: VerifiedResource, right: VerifiedResource): boolean =>
  left.treeDigest === right.treeDigest || (dynamicSkillIdentity.has(left) && dynamicSkillIdentity.get(left) === dynamicSkillIdentity.get(right));
export const carryDynamicSkillIdentity = (source: VerifiedResource, target: VerifiedResource): void => {
  const identity = dynamicSkillIdentity.get(source);
  if (identity) dynamicSkillIdentity.set(target, identity);
};
const pluginRootToken = /\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/gu;
const unavailablePluginValue = /\$\{(?:CLAUDE_PLUGIN_DATA|PLUGIN_DATA|user_config(?:\.[^}]*)?)\}/iu;

const lockedSubtree = (bundle: Awaited<ReturnType<typeof readPluginBundles>>[number],
  files: ReadonlyMap<string, Buffer>, path: string, kind: "skill" | "rule"): Snapshot => {
  const prefix = kind === "skill" ? `${path}/` : path;
  const directories = kind === "skill" ? bundle.entries.flatMap(entry =>
    entry.kind === "directory" && entry.path.startsWith(prefix) ? [entry.path.slice(prefix.length)] : []) : [];
  const selected = bundle.entries.flatMap(entry => {
    if (entry.kind !== "file" || (kind === "rule" ? entry.path !== path : !entry.path.startsWith(prefix))) return [];
    const relative = kind === "rule" ? "content.md" : entry.path.slice(prefix.length);
    const bytes = files.get(entry.path);
    if (!bytes || bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.digest) {
      throw modeError("E_INTEGRITY", "Plugin resource bytes differ from the locked package", { plugin: bundle.id, path: entry.path });
    }
    return [{ path: relative, bytes, executable: entry.executable }];
  });
  return fromFiles(directories, selected);
};

const namespaceSkill = (snapshot: Snapshot, plugin: string): Snapshot => {
  const metadata = resourceEntry(snapshot, "skill").skill!;
  const name = `${plugin}-${metadata.name}`;
  if (name.length > 64) throw modeError("E_LIMIT", "Namespaced plugin skill name exceeds the supported length", { plugin });
  if (name === metadata.name) return snapshot;
  const entry = snapshot.files.get("SKILL.md")!;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes).replace(/^\uFEFF/u, "");
  const match = /^---\n([\s\S]*?)\n---([ \t]*(?:\n|$))([\s\S]*)$/u.exec(text);
  if (!match) throw modeError("E_INTEGRITY", "Plugin skill frontmatter cannot be safely namespaced", { plugin });
  const document = parseDocument(match[1]!, { schema: "core", uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length) throw modeError("E_INTEGRITY", "Plugin skill frontmatter cannot be safely namespaced", { plugin });
  document.set("name", name);
  const frontmatter = document.toString().replace(/\n*$/u, "");
  const bytes = Buffer.from(`---\n${frontmatter}\n---${match[2]}${match[3]}`);
  const files: FileData[] = [...snapshot.files.values()].map(file => ({ ...file,
    ...(file.path === "SKILL.md" ? { bytes } : {}),
  }));
  const result = fromFiles(snapshot.entries.filter(entry => entry.kind === "directory").map(entry => entry.path), files);
  if (resourceEntry(result, "skill").skill?.name !== name) {
    throw modeError("E_INTEGRITY", "Plugin skill frontmatter cannot be safely namespaced", { plugin });
  }
  return result;
};

const dynamicView = (snapshot: Snapshot, kind: "skill" | "rule", plugin: string, root: string): Snapshot => {
  const files: FileData[] = snapshot.entries.flatMap(entry => {
    if (entry.kind !== "file") return [];
    const file = snapshot.files.get(entry.path)!;
    const bytes = Buffer.from(file.bytes);
    if (bytes.includes(0)) return [{ ...file, bytes }];
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return [{ ...file, bytes }]; }
    if (unavailablePluginValue.test(text)) {
      throw modeError("E_INTEGRITY", "Dynamic plugin resource requires unavailable plugin data or user configuration", {
        plugin, path: entry.path,
      });
    }
    if (!text.includes("${CLAUDE_PLUGIN_ROOT}") && !text.includes("${PLUGIN_ROOT}")) return [{ ...file, bytes }];
    if (!/^\/[A-Za-z0-9_./:@+-]+$/u.test(root)) {
      throw modeError("E_PATH", "Plugin root contains characters unsafe for shell or JSON interpolation", { plugin });
    }
    return [{ ...file, bytes: Buffer.from(text.replace(pluginRootToken, root)) }];
  });
  return fromFiles(snapshot.entries.filter(entry => entry.kind === "directory").map(entry => entry.path), files);
};

export const attachDynamicPlugins = async (context: ConfigContext, plan: ResolvedPlan,
  resources: VerifiedResourceSet, stateRoot: string, agent: Agent,
  nativeNames: readonly string[] = []): Promise<{ readonly plan: ResolvedPlan; readonly resources: VerifiedResourceSet }> => {
  const pluginIds = plan.pluginIds ?? [];
  if (!pluginIds.length) return { plan, resources };
  if (agent !== "claude" && agent !== "codex") {
    throw modeError("E_CONFIG", "Dynamic plugin content is supported only for Claude Code and Codex", { agent });
  }
  const bundles = await readPluginBundles(context, pluginIds);
  const pluginContents = new Map(await Promise.all(bundles
    .map(async bundle => [bundle.id, await pluginFiles(bundle)] as const)));
  const native = new Set(nativeNames);
  const additions = await bundles.filter(bundle => (bundle.spec.agents ?? ["claude", "codex"]).includes(agent as PluginAgent)).reduce(async (pending, bundle) => {
    const found = await pending;
    const applicable = bundle.dynamic.filter(declaration => !declaration.agents || declaration.agents.includes(agent as PluginAgent));
    const dynamic = await applicable.reduce(async (items, declaration) => {
      const current = await items;
      const source = lockedSubtree(bundle, pluginContents.get(bundle.id)!, declaration.path, declaration.kind);
      const sourceIdentity = digest({ bundle: bundle.treeDigest, source: source.treeDigest,
        namespace: bundle.name, path: declaration.path });
      const materialized = dynamicView(source, declaration.kind, bundle.id, bundle.root);
      const snapshot = declaration.kind === "skill" ? namespaceSkill(materialized, bundle.name) : materialized;
      const skillName = resourceEntry(snapshot, declaration.kind).skill?.name;
      if (skillName && native.has(skillName)) throw modeError("E_MODE_CONFLICT", "Namespaced plugin skill conflicts with a native skill", {
        plugin: bundle.id, skill: skillName,
      });
      const id = `${bundle.id}:${declaration.kind}:${declaration.id}`;
      const manifestResource = {
        id, kind: declaration.kind,
        sourceDigest: digest({ plugin: bundle.id, commit: bundle.commit, treeDigest: bundle.treeDigest, declaration }),
        commit: bundle.commit, treeDigest: snapshot.treeDigest, entries: snapshot.entries,
      };
      const verified = await publishObject(stateRoot, manifestResource, snapshot);
      if (verified.skill) dynamicSkillIdentity.set(verified, sourceIdentity);
      return [...current, { manifestResource, verified }];
    }, Promise.resolve([] as { manifestResource: VerifiedResourceSet["manifest"]["resources"][number]; verified: VerifiedResource }[]));
    return [...found, ...dynamic];
  }, Promise.resolve([] as { manifestResource: VerifiedResourceSet["manifest"]["resources"][number]; verified: VerifiedResource }[]));
  if (!additions.length) return { plan, resources };
  const candidateResources = [...resources.resources, ...additions.map(item => item.verified)];
  const uniqueResources = candidateResources.reduce<VerifiedResource[]>((unique, resource) => {
    if (!resource.skill) return [...unique, resource];
    const duplicate = unique.find(value => value.skill?.name === resource.skill!.name);
    if (duplicate && !sameDynamicSkillContent(duplicate, resource)) {
      throw modeError("E_MODE_CONFLICT", "Plugin skill conflicts with another selected skill", { name: resource.skill.name });
    }
    return duplicate ? unique : [...unique, resource];
  }, []);
  validateNames(uniqueResources);
  const retainedIds = new Set(uniqueResources.map(resource => resource.id));
  const manifest = {
    schemaVersion: 1 as const,
    resourceSpecDigest: digest({ base: resources.manifest.resourceSpecDigest,
      plugins: additions.map(item => ({ id: item.manifestResource.id, sourceDigest: item.manifestResource.sourceDigest })) }),
    resources: [...resources.manifest.resources, ...additions.map(item => item.manifestResource)]
      .filter(resource => retainedIds.has(resource.id))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  };
  const bytes = manifest.resources.reduce((sum, resource) => sum + resource.entries.reduce((total, entry) =>
    total + (entry.kind === "file" ? entry.bytes : 0), 0), 0);
  if (manifest.resources.length > LIMITS.resources || bytes > LIMITS.allResourceBytes
    || Buffer.byteLength(canonical(manifest)) > LIMITS.manifestBytes) {
    throw modeError("E_LIMIT", "Selected plugin resources exceed context resource limits");
  }
  const resourceDigest = digest(manifest);
  const nextResources: VerifiedResourceSet = { ...resources, manifest, resourceDigest, resources: uniqueResources };
  const nextPlan: ResolvedPlan = { ...plan, resourceDigest,
    resources: [...plan.resources, ...additions.map(item => ({ id: item.manifestResource.id, kind: item.manifestResource.kind }))]
      .filter(resource => retainedIds.has(resource.id)) };
  return { plan: nextPlan, resources: nextResources };
};
