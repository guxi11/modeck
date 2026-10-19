import { isAbsolute, join } from "node:path";
import { agents, canonical, isAgent, LIMITS, modeError, PROTOCOL, sha256 } from "../contracts/index.js";
import type { CompileRequest, RenderedContext } from "../contracts/index.js";
import { immutable, requireValue } from "./values.js";

const normalized = (text: string): string => text.replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
const content = (bytes: Readonly<Uint8Array>): string => {
  try { return normalized(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { throw modeError("E_INTEGRITY", "Resource entry is not valid UTF-8"); }
};
const withoutFinalLf = (text: string): string => text.replace(/\n+$/, "");

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
  const index = skills.map(({ resource }) => canonical({
    name: resource.skill!.name, description: resource.skill!.description, root: resource.root,
    entry: resource.entry })).join("\n");
  // An empty selection injects no wrapper block at all, never an empty scaffold.
  const skillSection = skills.length ? [`<SKILLS>\n\nMatch skills by name and description. When a skill applies, read its complete SKILL.md at the absolute entry path before following its instructions. Read supporting references only as needed; resolve bundled paths from root, not the project working directory. Scripts are not run automatically and remain subject to normal tool permissions. These indexed resources are not registered native skills.\n\n${index}\n\n</SKILLS>`] : [];
  const sections = [...instructions, ...skillSection];
  const text = sections.length ? `${sections.map(withoutFinalLf).join("\n\n")}\n` : "";
  const byteLength = Buffer.byteLength(text, "utf8");
  requireValue(text.length <= LIMITS.contextChars && byteLength <= LIMITS.contextBytes,
    "E_CONTEXT_SIZE", "Context exceeds the complete-output limit", { chars: text.length, byteLength,
      maxChars: LIMITS.contextChars, maxBytes: LIMITS.contextBytes });
  return immutable({ schemaVersion: 1 as const, protocol: PROTOCOL, agent,
    configDigest: plan.configDigest, resourceDigest: plan.resourceDigest, selectionDigest,
    modeIds: [...plan.modeIds], text, contentDigest: sha256(Buffer.from(text, "utf8")), byteLength,
    filtered });
};
