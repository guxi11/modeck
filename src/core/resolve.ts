import { modeError } from "../contracts/index.js";
import type { BoundResource, Condition, Reason, ResolvedPlan, ResolveRequest } from "../contracts/index.js";
import { compare, glob, immutable } from "./values.js";

type Expansion = { readonly modes: readonly string[]; readonly reasons: readonly Reason[] };

export const resolve = ({ context, facts, lockDigest }: ResolveRequest): ResolvedPlan => {
  const { config } = context;
  const selector = facts.selector?.value;
  const files = new Set(facts.files);
  const dependencies = new Set(facts.dependencies);
  const matches = (condition: Condition): boolean => {
    if (condition.type === "exists") return files.has(condition.path);
    if (condition.type === "dependency") return dependencies.has(condition.name);
    const matcher = glob(condition.pattern);
    return facts.files.some(file => matcher.test(file));
  };
  const reason = (mode: string, via: Reason["via"], from: string | null = null,
    conditionIndex: number | null = null): Reason => ({ mode, via, from, conditionIndex });
  const disabled = new Set(selector?.disable ?? []);
  [...selector?.add ?? [], ...disabled].forEach(id => {
    if (!Object.hasOwn(config.modes, id)) throw modeError("E_SELECTOR", "Selector references unknown mode", { id, path: facts.selector?.path });
  });
  const overlap = selector?.add.find(id => disabled.has(id));
  if (overlap) throw modeError("E_MODE_CONFLICT", "Mode is both added and disabled", { id: overlap });
  const detected = selector?.auto === false ? [] : context.autoModeIds !== undefined
    ? [...context.autoModeIds].sort((a, b) => config.modes[a]!.priority - config.modes[b]!.priority || compare(a, b))
      .map(id => reason(id, "detect")) : Object.entries(config.modes)
    .map(([id, mode]) => ({ id, mode, match: mode.detect?.any.findIndex(matches) ?? -1 }))
    .filter(candidate => candidate.match >= 0)
    .sort((a, b) => a.mode.priority - b.mode.priority || compare(a.id, b.id))
    .map(candidate => reason(candidate.id, "detect", null, candidate.match));
  const seeds = [...config.defaults.map(id => reason(id, "default")), ...detected,
    ...selector?.add.map(id => reason(id, "selector")) ?? []].filter(seed => !disabled.has(seed.mode));
  const expand = (source: Reason, chain: readonly string[], state: Expansion): Expansion => {
    const id = source.mode;
    if (disabled.has(id)) throw modeError("E_MODE_CONFLICT", "Selected mode depends on disabled parent", { chain: [...chain, id] });
    if (chain.includes(id)) throw modeError("E_CONFIG", "Mode inheritance cycle", { chain: [...chain, id] });
    const mode = config.modes[id];
    if (!mode) throw modeError("E_CONFIG", "Unknown selected mode", { id });
    const withReason = { modes: state.modes, reasons: [...state.reasons, source] };
    if (state.modes.includes(id)) return withReason;
    const parents = mode.extends.reduce((current, parent) =>
      expand(reason(parent, "parent", id), [...chain, id], current), withReason as Expansion);
    return { modes: [...parents.modes, id], reasons: parents.reasons };
  };
  const selected = seeds.reduce((state, seed) => expand(seed, [], state), { modes: [], reasons: [] } as Expansion);
  const resources = selected.modes.flatMap(id => {
    const mode = config.modes[id]!;
    return [...mode.rules.map(resource => ({ id: resource, kind: "rule" as const, preload: true })),
      ...mode.skills.map(skill => ({ ...skill, kind: "skill" as const }))];
  }).reduce<readonly BoundResource[]>((ordered, binding) => {
    const old = ordered.find(resource => resource.id === binding.id);
    if (config.resources[binding.id]?.kind !== binding.kind || old && old.kind !== binding.kind) {
      throw modeError("E_CONFIG", "Resource binding kind mismatch", { id: binding.id });
    }
    return old ? ordered.map(resource => resource.id === binding.id
      ? { ...resource, preload: resource.preload || binding.preload } : resource) : [...ordered, binding];
  }, []);
  return immutable({ schemaVersion: 1 as const, configDigest: context.configDigest, lockDigest,
    cwd: facts.cwd, boundary: facts.boundary, selectorPath: facts.selector?.path ?? null,
    modeIds: selected.modes, resources, reasons: selected.reasons, diagnostics: [] });
};
