import { relative, isAbsolute } from "node:path";
import { collectFacts, compile, loadConfig, parseManifest, resolve } from "../core/index.js";
import { readResources } from "../resources/index.js";
import { canonical, LIMITS, modeError, sha256 } from "../contracts/index.js";
import type { ConfigContext, PrepareRequest, PreparedContext, ProjectFacts, ResolvedPlan, VerifiedResourceSet } from "../contracts/index.js";
import { validateConfig } from "../core/config.js";
import { safeAbsolute } from "./fs.js";
import { nativeInstructionTexts, nativeSkillNames } from "./native-skills.js";
import { loadRegistry } from "./registry.js";
import { attachDynamicPlugins, carryDynamicSkillIdentity, sameDynamicSkillContent } from "../plugins/dynamic.js";

type PreparedProject = Readonly<{ context: ConfigContext; plan: ResolvedPlan; resources: VerifiedResourceSet }>;
const hash = (value: unknown): string => sha256(Buffer.from(canonical(value)));

const project = async (context: ConfigContext, facts: ProjectFacts, state: string, agent: PrepareRequest["agent"],
  nativeNames: readonly string[]): Promise<PreparedProject> => {
  const rel = relative(context.configRoot, state);
  if (rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")) throw modeError("E_PATH", "State must be outside the configuration repository");
  // Selection precedes I/O so unrelated unavailable resources cannot block a mode.
  const selection = resolve({ context, facts, resourceDigest: "0".repeat(64) });
  const baseResources: VerifiedResourceSet = await readResources({ context, stateRoot: state, parseManifest,
    resourceIds: selection.resources.map(resource => resource.id) });
  const basePlan = resolve({ context, facts, resourceDigest: baseResources.resourceDigest });
  const { plan, resources } = await attachDynamicPlugins(context, basePlan, baseResources, state, agent, nativeNames);
  return { context, plan, resources };
};

const aggregate = (projects: readonly PreparedProject[], facts: ProjectFacts): Pick<PreparedProject, "plan" | "resources"> => {
  const qualified = projects.map(({ context, plan, resources }) => {
    const prefix = sha256(Buffer.from(context.configRoot));
    const id = (value: string): string => `${prefix}:${value}`;
    return {
      plan: { ...plan, modeIds: plan.modeIds.map(id), pluginIds: plan.pluginIds.map(id), resources: plan.resources.map(resource => ({ ...resource, id: id(resource.id) })),
        reasons: plan.reasons.map(reason => ({ ...reason, mode: id(reason.mode), from: reason.from === null ? null : id(reason.from) })) },
      resources: resources.resources.map(resource => {
        const qualified = { ...resource, id: id(resource.id) };
        carryDynamicSkillIdentity(resource, qualified);
        return qualified;
      }),
      manifest: resources.manifest.resources.map(resource => ({ ...resource, id: id(resource.id) })),
    };
  });
  const selected = qualified.flatMap(value => value.resources);
  const unique = selected.reduce<typeof selected>((previous, resource) => {
    if (!resource.skill) return [...previous, resource];
    const duplicate = previous.find(other => other.skill?.name === resource.skill!.name);
    if (duplicate && !sameDynamicSkillContent(duplicate, resource)) {
      throw modeError("E_CONFIG", "Registered configurations define different content for the same skill name", { name: resource.skill.name });
    }
    return duplicate ? previous : [...previous, resource];
  }, []);
  const retained = new Set(unique.map(resource => resource.id));
  const manifest = {
    schemaVersion: 1 as const,
    resourceSpecDigest: hash(projects.map(({ context, resources }) => ({ root: context.configRoot, digest: resources.manifest.resourceSpecDigest }))),
    resources: qualified.flatMap(value => value.manifest).filter(resource => retained.has(resource.id))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  };
  const bytes = manifest.resources.reduce((sum, resource) => sum + resource.entries.reduce((total, entry) => total + (entry.kind === "file" ? entry.bytes : 0), 0), 0);
  const modeIds = qualified.flatMap(value => value.plan.modeIds);
  if (selected.length > LIMITS.resources || modeIds.length > LIMITS.modes || bytes > LIMITS.allResourceBytes
    || Buffer.byteLength(canonical(manifest)) > LIMITS.manifestBytes) {
    throw modeError("E_LIMIT", "Combined configurations exceed resource or mode limits");
  }
  const configDigest = hash(projects.map(({ context }) => ({ root: context.configRoot, digest: context.configDigest })));
  const resourceDigest = hash(manifest);
  const resources: VerifiedResourceSet = { schemaVersion: 1, configDigest, resourceDigest, manifest, resources: unique };
  const plan: ResolvedPlan = {
    schemaVersion: 1, configDigest, resourceDigest, cwd: facts.cwd, boundary: facts.boundary, selectorPath: facts.selector?.path ?? null,
    modeIds, pluginIds: qualified.flatMap(value => value.plan.pluginIds),
    resources: qualified.flatMap(value => value.plan.resources).filter(resource => retained.has(resource.id)),
    reasons: qualified.flatMap(value => value.plan.reasons), diagnostics: qualified.flatMap(value => value.plan.diagnostics),
  };
  return { plan, resources };
};

export const prepare = async ({ configRoot, configRoots, stateRoot, cwd, agent }: PrepareRequest): Promise<PreparedContext> => {
  const root = await safeAbsolute(configRoot);
  const state = await safeAbsolute(stateRoot);
  const facts = await collectFacts({ cwd, stateRoot: state });
  const nativeNames = await nativeSkillNames(facts.cwd, agent, facts.boundary);
  const nativeTexts = await nativeInstructionTexts(facts.cwd, agent, facts.boundary);
  const registry = configRoots === undefined ? await loadRegistry(root) : null;
  const roots = await Promise.all((configRoots ?? (registry ? registry.projects.filter(value => value.enabled).map(value => value.root) : [root])).map(safeAbsolute));
  if (roots.length > LIMITS.modes || new Set(roots).size !== roots.length) throw modeError("E_CONFIG", "Invalid configuration project selection");
  const contexts = await Promise.all(roots.map(configRoot => loadConfig({ configRoot, facts })));
  const combined = configRoots !== undefined || registry !== null;
  if (combined && contexts.length) (facts.selector?.value.add ?? []).forEach(id => {
    if (!contexts.some(context => Object.hasOwn(context.config.modes, id))) {
      throw modeError("E_SELECTOR", "Selector references unknown mode", { id, path: facts.selector?.path });
    }
  });
  const projects = await contexts.reduce(async (pending, context) => {
    const previous = await pending;
    // A business selector applies to every project defining that mode, without crossing project inheritance graphs.
    const localFacts = !combined || !facts.selector ? facts : { ...facts, selector: { ...facts.selector,
      value: { ...facts.selector.value, add: facts.selector.value.add.filter(id => Object.hasOwn(context.config.modes, id)) } } };
    return [...previous, await project(context, localFacts, state, agent, nativeNames)];
  }, Promise.resolve<readonly PreparedProject[]>([]));
  await Promise.all(contexts.map(validateConfig));
  if (configRoots === undefined && canonical(await loadRegistry(root)) !== canonical(registry)) {
    throw modeError("E_CONFIG", "Configuration registry changed while preparing context");
  }
  const { plan: selected, resources } = combined ? aggregate(projects, facts) : projects[0]!;
  // Paths skipped while collecting facts stay visible as diagnostics; they never block context injection.
  const plan: ResolvedPlan = { ...selected, diagnostics: [
    ...facts.excluded.map(item => ({ code: "SCAN_SKIPPED", message: item.reason, path: item.path })), ...selected.diagnostics] };
  return { plan, rendered: compile({ plan, resources, agent, nativeSkillNames: nativeNames, nativeInstructions: nativeTexts }) };
};
