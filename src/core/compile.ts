import { isAbsolute, join } from "node:path";
import { canonical, LIMITS, modeError, PROTOCOL, sha256 } from "../contracts/index.js";
import type { CompileRequest, RenderedContext } from "../contracts/index.js";
import { immutable, requireValue } from "./values.js";

const normalized = (text: string): string => text.replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
const content = (bytes: Readonly<Uint8Array>): string => {
  try { return normalized(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { throw modeError("E_INTEGRITY", "Resource entry is not valid UTF-8"); }
};
const withoutFinalLf = (text: string): string => text.replace(/\n+$/, "");

export const compile = ({ plan, resources, agent, nativeSkillNames = [] }: CompileRequest): RenderedContext => {
  requireValue(plan.configDigest === resources.configDigest && plan.resourceDigest === resources.resourceDigest,
    "E_INTEGRITY", "Plan and verified resources have different identities");
  requireValue(agent === "codex" || agent === "claude" || agent === "codebuddy", "E_CONFIG", "Unsupported agent");
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
  const selected = bound.filter(({ binding, resource }) => binding.kind !== "skill" || !native.has(resource.skill!.name));
  const identity = selected.map(({ binding, resource }) => ({ id: binding.id, kind: binding.kind,
    treeDigest: resource.treeDigest }));
  const selectionDigest = sha256(Buffer.from(canonical({ protocol: PROTOCOL, agent, modeIds: plan.modeIds, resources: identity })));
  const rules = selected.filter(({ binding }) => binding.kind === "rule")
    .map(({ binding, resource }) => `<!-- rule: ${binding.id} -->\n\n${content(resource.entryBytes)}`);
  const instructions = rules.length ? [`<INSTRUCTIONS>\n\n${rules.map(withoutFinalLf).join("\n\n")}\n\n</INSTRUCTIONS>`] : [];
  const skills = selected.filter(({ binding }) => binding.kind === "skill");
  const index = skills.map(({ binding, resource }) => canonical({ id: binding.id,
    name: resource.skill!.name, description: resource.skill!.description, root: resource.root,
    entry: resource.entry })).join("\n");
  const skillSection = `<SKILLS>\n\nMatch skills by name and description. When a skill applies, read its complete SKILL.md at the absolute entry path before following its instructions. Read supporting references only as needed; resolve bundled paths from root, not the project working directory. Scripts are not run automatically and remain subject to normal tool permissions. These indexed resources are not registered native skills.\n\n${index}\n\n</SKILLS>`;
  const text = `${[...instructions, skillSection].map(withoutFinalLf).join("\n\n")}\n`;
  const byteLength = Buffer.byteLength(text, "utf8");
  requireValue(text.length <= LIMITS.contextChars && byteLength <= LIMITS.contextBytes,
    "E_CONTEXT_SIZE", "Context exceeds the complete-output limit", { chars: text.length, byteLength,
      maxChars: LIMITS.contextChars, maxBytes: LIMITS.contextBytes });
  return immutable({ schemaVersion: 1 as const, protocol: PROTOCOL, agent,
    configDigest: plan.configDigest, resourceDigest: plan.resourceDigest, selectionDigest,
    modeIds: [...plan.modeIds], text, contentDigest: sha256(Buffer.from(text, "utf8")), byteLength });
};
