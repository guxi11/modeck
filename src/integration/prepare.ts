import { relative, isAbsolute } from "node:path";
import { collectFacts, compile, loadConfig, parseManifest, resolve } from "../core/index.js";
import { readResources } from "../resources/index.js";
import { canonical, LIMITS, modeError, sha256 } from "../contracts/index.js";
import type { ConfigContext, ConfigSource, McpProvenance, McpServer, PrepareRequest, PreparedContext, ProjectFacts, ResolvedPlan, VerifiedResourceSet } from "../contracts/index.js";
import { validateConfig } from "../core/config.js";
import { safeAbsolute } from "./fs.js";
import { nativeSkillNames } from "./native-skills.js";
import { loadRegistry, sourceFor } from "./registry.js";

type SelectedProject = Readonly<{ source: ConfigSource; context: ConfigContext; facts: ProjectFacts; plan: ResolvedPlan }>;
type PreparedProject = SelectedProject & Readonly<{ resources: VerifiedResourceSet }>;
type McpSelection = Readonly<{ entries: Readonly<Record<string, Readonly<{ server: McpServer; source: ConfigSource }>>>;
  provenance: readonly McpProvenance[] }>;
const hash = (value: unknown): string => sha256(Buffer.from(canonical(value)));

const project = async ({ source, context, facts, plan: selection }: SelectedProject, state: string): Promise<PreparedProject> => {
  const resources: VerifiedResourceSet = await readResources({ context, stateRoot: state, parseManifest,
    resourceIds: selection.resources.map(resource => resource.id) });
  const plan = resolve({ context, facts, resourceDigest: resources.resourceDigest });
  return { source, context, facts, plan, resources };
};

const selectedMcp = (projects: readonly SelectedProject[]): PreparedContext["mcp"] => {
  const selected = projects.reduce<McpSelection>((previous, { source, context, plan }) =>
    plan.mcp.reduce((selected, id) => {
      const declaration = Object.hasOwn(context.config.mcp.servers, id) ? context.config.mcp.servers[id] : undefined;
      if (!declaration) throw modeError("E_CONFIG", "Selected MCP server is not declared", { server: id, source });
      const { override, ...server } = declaration;
      const existing = Object.hasOwn(selected.entries, id) ? selected.entries[id] : undefined;
      const identical = existing !== undefined && canonical(existing.server) === canonical(server);
      if (existing && !identical && override !== true) {
        throw modeError("E_MODE_CONFLICT", `MCP server "${id}" differs between ${existing.source.role}:${existing.source.namespace} and ${source.role}:${source.namespace}; the later source must set override: true`,
          { server: id, previous: existing.source, incoming: source });
      }
      const origin = sourceFor(source);
      const modeIds = plan.modeIds.filter(mode => Object.hasOwn(context.config.modes, mode) && context.config.modes[mode]!.mcp.includes(id));
      return { entries: identical ? selected.entries : { ...selected.entries, [id]: { server, source } },
        provenance: [...selected.provenance, { server: id, root: origin.root, role: origin.role, namespace: origin.namespace,
          modeIds, action: identical ? "deduplicate" : existing ? "override" : "select" }] };
    }, previous), { entries: {}, provenance: [] });
  const servers = Object.fromEntries(Object.entries(selected.entries).map(([id, { server }]) => [id, server]));
  if (Object.keys(servers).length > LIMITS.modes) throw modeError("E_LIMIT", "Combined configurations exceed the MCP server limit");
  return { servers, provenance: selected.provenance, configDigest: hash({ sources: projects.map(({ source, context, plan }) => ({
    root: source.root, role: source.role, namespace: source.namespace, configDigest: context.configDigest, modeIds: plan.modeIds,
  })), servers, provenance: selected.provenance }) };
};

const aggregate = (projects: readonly PreparedProject[], facts: ProjectFacts): Pick<PreparedProject, "plan" | "resources"> => {
  const qualified = projects.map(({ source, plan, resources }) => {
    const prefix = source.namespace!;
    const id = (value: string): string => `${prefix}:${value}`;
    return {
      plan: { ...plan, modeIds: plan.modeIds.map(id), resources: plan.resources.map(resource => ({ ...resource, id: id(resource.id) })),
        reasons: plan.reasons.map(reason => ({ ...reason, mode: id(reason.mode), from: reason.from === null ? null : id(reason.from) })) },
      resources: resources.resources.map(resource => ({ ...resource, id: id(resource.id) })),
      manifest: resources.manifest.resources.map(resource => ({ ...resource, id: id(resource.id) })),
    };
  });
  const selected = qualified.flatMap(value => value.resources);
  const unique = selected.reduce<typeof selected>((previous, resource) => {
    if (!resource.skill) return [...previous, resource];
    const duplicate = previous.find(other => other.skill?.name === resource.skill!.name);
    if (duplicate && duplicate.treeDigest !== resource.treeDigest) {
      throw modeError("E_CONFIG", "Registered configurations define different content for the same skill name", { name: resource.skill.name });
    }
    return duplicate ? previous : [...previous, resource];
  }, []);
  const retained = new Set(unique.map(resource => resource.id));
  const manifest = {
    schemaVersion: 1 as const,
    resourceSpecDigest: hash(projects.map(({ source, resources }) => ({ source, digest: resources.manifest.resourceSpecDigest }))),
    resources: qualified.flatMap(value => value.manifest).filter(resource => retained.has(resource.id))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  };
  const bytes = manifest.resources.reduce((sum, resource) => sum + resource.entries.reduce((total, entry) => total + (entry.kind === "file" ? entry.bytes : 0), 0), 0);
  const modeIds = qualified.flatMap(value => value.plan.modeIds);
  if (selected.length > LIMITS.resources || modeIds.length > LIMITS.modes || bytes > LIMITS.allResourceBytes
    || Buffer.byteLength(canonical(manifest)) > LIMITS.manifestBytes) {
    throw modeError("E_LIMIT", "Combined configurations exceed resource or mode limits");
  }
  const configDigest = hash(projects.map(({ source, context }) => ({ source, digest: context.configDigest })));
  const resourceDigest = hash(manifest);
  const resources: VerifiedResourceSet = { schemaVersion: 1, configDigest, resourceDigest, manifest, resources: unique };
  const plan: ResolvedPlan = {
    schemaVersion: 1, configDigest, resourceDigest, cwd: facts.cwd, boundary: facts.boundary, selectorPath: facts.selector?.path ?? null,
    modeIds, resources: qualified.flatMap(value => value.plan.resources).filter(resource => retained.has(resource.id)),
    mcp: [...new Set(projects.flatMap(value => value.plan.mcp))],
    reasons: qualified.flatMap(value => value.plan.reasons), diagnostics: qualified.flatMap(value => value.plan.diagnostics),
  };
  return { plan, resources };
};

const prepareSelection = async ({ configRoot, configRoots, stateRoot, cwd }: Omit<PrepareRequest, "agent">) => {
  const root = await safeAbsolute(configRoot);
  const state = await safeAbsolute(stateRoot);
  const facts = await collectFacts({ cwd, stateRoot: state });
  const registry = await loadRegistry(root);
  const roots = await Promise.all((configRoots ?? (registry ? registry.projects.filter(value => value.enabled).map(value => value.root) : [root])).map(safeAbsolute));
  if (roots.length > LIMITS.modes || new Set(roots).size !== roots.length) throw modeError("E_CONFIG", "Invalid configuration project selection");
  const sources = roots.map(root => sourceFor({ ...registry?.projects.find(source => source.root === root), root, enabled: true }));
  if (new Set(sources.map(source => source.namespace)).size !== sources.length) throw modeError("E_CONFIG", "Duplicate selected configuration source namespace");
  const contexts = await Promise.all(roots.map(configRoot => loadConfig({ configRoot, facts })));
  const combined = configRoots !== undefined || registry !== null;
  if (combined && contexts.length) (facts.selector?.value.add ?? []).forEach(id => {
    if (!contexts.some(context => Object.hasOwn(context.config.modes, id))) {
      throw modeError("E_SELECTOR", "Selector references unknown mode", { id, path: facts.selector?.path });
    }
  });
  const projects: readonly SelectedProject[] = contexts.map((context, index) => {
    const rel = relative(context.configRoot, state);
    if (rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")) throw modeError("E_PATH", "State must be outside the configuration repository");
    // A business selector applies to every project defining that mode, without crossing project inheritance graphs.
    const localFacts = !combined || !facts.selector ? facts : { ...facts, selector: { ...facts.selector,
      value: { ...facts.selector.value, add: facts.selector.value.add.filter(id => Object.hasOwn(context.config.modes, id)) } } };
    return { source: sources[index]!, context, facts: localFacts,
      plan: resolve({ context, facts: localFacts, resourceDigest: "0".repeat(64) }) };
  });
  const validate = async (): Promise<void> => {
    await Promise.all(contexts.map(validateConfig));
    if (canonical(await loadRegistry(root)) !== canonical(registry)) {
      throw modeError("E_CONFIG", "Configuration registry changed while preparing context");
    }
  };
  return { projects, facts, combined, state, validate };
};

export const prepareMcp = async (request: Omit<PrepareRequest, "agent">): Promise<PreparedContext["mcp"]> => {
  const { projects, validate } = await prepareSelection(request);
  const mcp = selectedMcp(projects);
  await validate();
  return mcp;
};

export const prepare = async (request: PrepareRequest): Promise<PreparedContext> => {
  const { agent } = request;
  const { projects: selected, facts, combined, state, validate } = await prepareSelection(request);
  const projects = await selected.reduce(async (pending, selection) => [...await pending, await project(selection, state)],
    Promise.resolve<readonly PreparedProject[]>([]));
  await validate();
  const { plan, resources } = combined ? aggregate(projects, facts) : projects[0]!;
  return { plan, mcp: selectedMcp(projects), rendered: compile({ plan, resources, agent,
    nativeSkillNames: await nativeSkillNames(facts.cwd, agent, facts.boundary) }) };
};
