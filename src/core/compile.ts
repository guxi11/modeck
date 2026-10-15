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

export const compile = ({ plan, resources, agent }: CompileRequest): RenderedContext => {
  requireValue(plan.configDigest === resources.configDigest && plan.lockDigest === resources.lockDigest,
    "E_INTEGRITY", "Plan and verified resources have different identities");
  requireValue(agent === "codex" || agent === "claude", "E_CONFIG", "Unsupported agent");
  const available = new Map(resources.resources.map(resource => [resource.id, resource]));
  const locked = new Map(resources.lock.resources.map(resource => [resource.id, resource]));
  requireValue(available.size === resources.resources.length, "E_INTEGRITY", "Duplicate verified resource id");
  const bound = plan.resources.map(binding => {
    const resource = available.get(binding.id);
    const lock = locked.get(binding.id);
    if (!resource || !lock || resource.kind !== binding.kind || lock.kind !== binding.kind
      || lock.treeDigest !== resource.treeDigest) throw modeError("E_INTEGRITY", "Selected resource is not verified", { id: binding.id });
    requireValue(isAbsolute(resource.root) && resource.entry === join(resource.root,
      binding.kind === "rule" ? "content.md" : "SKILL.md"), "E_PATH", "Invalid resource locator", { id: binding.id });
    requireValue(resource.entryBytes.byteLength <= LIMITS.textFileBytes, "E_LIMIT", "Resource entry exceeds byte limit", { id: binding.id });
    requireValue(binding.kind !== "skill" || resource.skill !== null, "E_INTEGRITY", "Skill metadata is missing", { id: binding.id });
    return { binding, resource };
  });
  const identity = bound.map(({ binding, resource }) => ({ id: binding.id, kind: binding.kind,
    treeDigest: resource.treeDigest, preload: binding.preload }));
  const selectionDigest = sha256(Buffer.from(canonical({ protocol: PROTOCOL, agent, modeIds: plan.modeIds, resources: identity })));
  const header = [`# ${PROTOCOL}`, `agent: ${agent}`, `selection: ${selectionDigest}`, `modes: ${canonical(plan.modeIds)}`].join("\n");
  const rules = bound.filter(({ binding }) => binding.kind === "rule")
    .map(({ binding, resource }) => `## rule ${binding.id}\n\n${content(resource.entryBytes)}`);
  const skills = bound.filter(({ binding }) => binding.kind === "skill");
  const index = skills.map(({ binding, resource }) => canonical({ id: binding.id,
    name: resource.skill!.name, description: resource.skill!.description, root: resource.root,
    entry: resource.entry, preload: binding.preload })).join("\n");
  const skillSection = `## skills\n\nSkill paths resolve from the indexed root; scripts are not run automatically.\n\n${index}`;
  const preloads = skills.filter(({ binding }) => binding.preload)
    .map(({ binding, resource }) => `## skill ${binding.id}\n\n${normalized(resource.skill!.body)}`);
  const text = `${[header, ...rules, skillSection, ...preloads].map(withoutFinalLf).join("\n\n")}\n`;
  const byteLength = Buffer.byteLength(text, "utf8");
  requireValue(text.length <= LIMITS.contextChars && byteLength <= LIMITS.contextBytes,
    "E_CONTEXT_SIZE", "Context exceeds the complete-output limit", { chars: text.length, byteLength,
      maxChars: LIMITS.contextChars, maxBytes: LIMITS.contextBytes });
  return immutable({ schemaVersion: 1 as const, protocol: PROTOCOL, agent,
    configDigest: plan.configDigest, lockDigest: plan.lockDigest, selectionDigest,
    modeIds: [...plan.modeIds], text, contentDigest: sha256(Buffer.from(text, "utf8")), byteLength });
};
