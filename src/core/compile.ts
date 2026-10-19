import { isAbsolute, join } from "node:path";
import { agentDefinitions, agents, canonical, isAgent, LIMITS, modeError, PROTOCOL, sha256 } from "../contracts/index.js";
import type { CompileRequest, FilteredResource, RenderedContext, VerifiedResource } from "../contracts/index.js";
import { immutable, requireValue } from "./values.js";

const normalized = (text: string): string => text.replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
const content = (bytes: Readonly<Uint8Array>): string => {
  try { return normalized(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { throw modeError("E_INTEGRITY", "Resource entry is not valid UTF-8"); }
};
const withoutFinalLf = (text: string): string => text.replace(/\n+$/, "");

// Keeps the leading sentence-ish prefix so a shortened description still triggers
// on the same topics.
const clipped = (description: string): string => {
  if (description.length <= LIMITS.contextDescriptionChars) return description;
  const head = description.slice(0, LIMITS.contextDescriptionChars);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("。"), head.lastIndexOf(" "), 0);
  return `${head.slice(0, stop || LIMITS.contextDescriptionChars).trimEnd()}…`;
};

export const compile = ({ plan, resources, agent, nativeSkillNames = [], nativeInstructions = [] }: CompileRequest): RenderedContext => {
  requireValue(plan.configDigest === resources.configDigest && plan.resourceDigest === resources.resourceDigest,
    "E_INTEGRITY", "Plan and verified resources have different identities");
  requireValue(isAgent(agent), "E_CONFIG", `Unsupported agent; choose ${agents.join(", ")}`);
  const available = new Map(resources.resources.map(resource => [resource.id, resource]));
  const manifests = new Map(resources.manifest.resources.map(resource => [resource.id, resource]));
  requireValue(available.size === resources.resources.length, "E_INTEGRITY", "Duplicate verified resource id");
  const bound = plan.resources.map(binding => {
    const resource = available.get(binding.id);
    const manifest = manifests.get(binding.id);
    if (!resource || !manifest || resource.kind !== binding.kind || manifest.kind !== binding.kind
      || manifest.treeDigest !== resource.treeDigest) throw modeError("E_INTEGRITY", "Selected resource is not verified", { id: binding.id });
    requireValue(isAbsolute(resource.root) && resource.entry === join(resource.root,
      binding.kind === "rule" ? "content.md" : "SKILL.md"), "E_PATH", "Invalid resource locator", { id: binding.id });
    requireValue(resource.entryBytes.byteLength <= LIMITS.textFileBytes, "E_LIMIT", "Resource entry exceeds byte limit", { id: binding.id });
    requireValue(binding.kind !== "skill" || resource.skill !== null, "E_INTEGRITY", "Skill metadata is missing", { id: binding.id });
    return { binding, resource };
  });
  const native = new Set(nativeSkillNames);
  // A rule is dropped only when its whole body (trimmed) already exists verbatim inside a
  // native instruction file; a same-topic but different body is kept. The length floor
  // keeps short bodies from matching coincidental substrings.
  const redundantRule = (text: string): boolean => {
    const body = text.trim();
    return body.length >= 32 && nativeInstructions.some(value => value.includes(body));
  };
  const keep = bound.map(({ binding, resource }) => ({ binding, resource,
    keep: binding.kind === "skill" ? !native.has(resource.skill!.name) : !redundantRule(content(resource.entryBytes)) }));
  const selected = keep.filter(item => item.keep);
  const filtered = keep.filter(item => !item.keep)
    .map(({ binding }) => ({ id: binding.id, kind: binding.kind,
      basis: binding.kind === "skill" ? "native-skill" as const : "native-instruction" as const }));
  const identity = selected.map(({ binding, resource }) => ({ id: binding.id, kind: binding.kind,
    treeDigest: resource.treeDigest }));
  const selectionDigest = sha256(Buffer.from(canonical({ protocol: PROTOCOL, agent, modeIds: plan.modeIds, resources: identity })));
  const rules = selected.filter(({ binding }) => binding.kind === "rule")
    .map(({ resource }) => content(resource.entryBytes));
  const instructions = rules.length ? [`<INSTRUCTIONS>\n\n${rules.map(withoutFinalLf).join("\n\n")}\n\n</INSTRUCTIONS>`] : [];
  const skills = selected.filter(({ binding }) => binding.kind === "skill");
  const entry = (resource: VerifiedResource, description: string): string => canonical({
    name: resource.skill!.name, description, root: resource.root, entry: resource.entry });
  const skillSection = (lines: readonly string[]): string =>
    `<SKILLS>\n\nMatch skills by name and description. When a skill applies, read its complete SKILL.md at the absolute entry path before following its instructions. Read supporting references only as needed; resolve bundled paths from root, not the project working directory. Scripts are not run automatically and remain subject to normal tool permissions. These indexed resources are not registered native skills.\n\n${lines.join("\n")}\n\n</SKILLS>`;
  const assemble = (lines: readonly string[]): string => {
    const sections = [...instructions, ...(lines.length ? [skillSection(lines)] : [])];
    return sections.length ? `${sections.map(withoutFinalLf).join("\n\n")}\n` : "";
  };
  // The injection budget is the agent platform's own cap when one is verified
  // (AgentAdapter.contextLimit), otherwise a defensive safety valve that must
  // never fire for ordinary configurations — only a runaway payload hits it.
  const maxChars = agentDefinitions[agent].contextLimit?.chars ?? LIMITS.contextSafetyValveChars;
  const within = (text: string): boolean => text.length <= maxChars;
  // Context-size degradation: rules are never reduced. Skills first lose description
  // detail, then whole index entries (largest first); each step stays observable
  // through rendered.filtered instead of failing the injection outright.
  let text = assemble(skills.map(({ resource }) => entry(resource, resource.skill!.description)));
  const sized: FilteredResource[] = [];
  if (!within(text) && skills.length) {
    const shortened = skills.map(({ binding, resource }) => ({ id: binding.id, line: entry(resource, clipped(resource.skill!.description)) }));
    let candidate = assemble(shortened.map(item => item.line));
    if (within(candidate)) {
      text = candidate;
      sized.push(...shortened.map(({ id }) => ({ id, kind: "skill" as const, basis: "context-size:description" as const })));
    } else {
      const dropped = new Set<string>();
      for (const item of [...shortened].sort((a, b) => b.line.length - a.line.length)) {
        dropped.add(item.id);
        candidate = assemble(shortened.filter(current => !dropped.has(current.id)).map(current => current.line));
        if (within(candidate)) break;
      }
      text = candidate;
      sized.push(...shortened.filter(current => !dropped.has(current.id))
        .map(({ id }) => ({ id, kind: "skill" as const, basis: "context-size:description" as const })));
      sized.push(...shortened.filter(current => dropped.has(current.id))
        .map(({ id }) => ({ id, kind: "skill" as const, basis: "context-size:skill" as const })));
    }
  }
  const byteLength = Buffer.byteLength(text, "utf8");
  requireValue(text.length <= maxChars,
    "E_CONTEXT_SIZE", "Context exceeds the complete-output limit", { chars: text.length, byteLength, maxChars,
      cause: "rules alone exceed the limit; shorten rule bodies or reduce selected modes" });
  return immutable({ schemaVersion: 1 as const, protocol: PROTOCOL, agent,
    configDigest: plan.configDigest, resourceDigest: plan.resourceDigest, selectionDigest,
    modeIds: [...plan.modeIds], text, contentDigest: sha256(Buffer.from(text, "utf8")), byteLength,
    filtered: [...filtered, ...sized] });
};
