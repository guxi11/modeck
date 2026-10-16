import { modeError } from "../contracts/index.js";
import type { BoundResource, Reason, ResolvedPlan, ResolveRequest } from "../contracts/index.js";
import { compare, immutable } from "./values.js";

type Expansion = { readonly modes: readonly string[]; readonly reasons: readonly Reason[] };

export const resolve = ({ context, facts, resourceDigest }: ResolveRequest): ResolvedPlan => {
  const { config } = context;
  const selector = facts.selector?.value;
  const reason = (mode: string, via: Reason["via"], from: string | null = null,
    conditionIndex: number | null = null): Reason => ({ mode, via, from, conditionIndex });
  (selector?.add ?? []).forEach(id => {
    if (!Object.hasOwn(config.modes, id)) throw modeError("E_SELECTOR", "Selector references unknown mode", { id, path: facts.selector?.path });
  });
  const detected = selector?.auto === false ? [] : [...context.autoModeIds ?? []]
    .sort((a, b) => config.modes[a]!.priority - config.modes[b]!.priority || compare(a, b))
    .map(id => reason(id, "detect"));
  const seeds = [...config.defaults.map(id => reason(id, "default")), ...detected,
    ...selector?.add.map(id => reason(id, "selector")) ?? []];
  const expand = (source: Reason, chain: readonly string[], state: Expansion): Expansion => {
    const id = source.mode;
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
    return [...mode.rules.map(resource => ({ id: resource, kind: "rule" as const })),
      ...mode.skills.map(skill => ({ id: skill, kind: "skill" as const }))];
  }).reduce<readonly BoundResource[]>((ordered, binding) => {
    const old = ordered.find(resource => resource.id === binding.id);
    if (config.resources[binding.id]?.kind !== binding.kind || old && old.kind !== binding.kind) {
      throw modeError("E_CONFIG", "Resource binding kind mismatch", { id: binding.id });
    }
    return old ? ordered : [...ordered, binding];
  }, []);
  return immutable({ schemaVersion: 1 as const, configDigest: context.configDigest, resourceDigest,
    cwd: facts.cwd, boundary: facts.boundary, selectorPath: facts.selector?.path ?? null,
    modeIds: selected.modes, resources, reasons: selected.reasons, diagnostics: [] });
};
