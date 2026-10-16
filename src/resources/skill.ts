import { isMap, parseDocument, visit } from "yaml";
import { LIMITS, modeError } from "../contracts/index.js";
import type { Kind, VerifiedResource } from "../contracts/index.js";
import { requireValue, utf8 } from "./fs.js";
import type { Snapshot } from "./tree.js";

export const resourceEntry = (snapshot: Snapshot, kind: Kind): {
  readonly entryBytes: Uint8Array; readonly skill: VerifiedResource["skill"];
} => {
  const entry = snapshot.files.get(kind === "rule" ? "content.md" : "SKILL.md");
  requireValue(entry && entry.bytes.byteLength <= LIMITS.textFileBytes,
    "E_INTEGRITY", "Missing or oversized resource entry");
  const entryBytes = Uint8Array.from(entry!.bytes);
  const text = utf8(entryBytes).replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n");
  if (kind === "rule") return { entryBytes, skill: null };
  requireValue(text.startsWith("---\n"), "E_INTEGRITY", "SKILL.md must start with YAML frontmatter");
  const end = /\n---[ \t]*(?:\n|$)/.exec(text.slice(4));
  requireValue(end, "E_INTEGRITY", "SKILL.md frontmatter is not terminated");
  const document = parseDocument(text.slice(4, 4 + end!.index), { schema: "core", uniqueKeys: true, strict: true });
  requireValue(!document.errors.length && !document.warnings.length && isMap(document.contents),
    "E_INTEGRITY", "Invalid skill YAML frontmatter");
  visit(document, { Alias: () => { throw modeError("E_INTEGRITY", "YAML aliases are not allowed in skills"); } });
  const metadata: unknown = document.toJS({ mapAsMap: true, maxAliasCount: 0 });
  requireValue(metadata instanceof Map, "E_INTEGRITY", "Skill metadata must be a mapping");
  const values = metadata as Map<unknown, unknown>;
  const name: unknown = values.get("name");
  const description: unknown = values.get("description");
  requireValue(typeof name === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(name)
    && name !== "modup", "E_INTEGRITY", "Invalid or reserved skill name");
  requireValue(typeof description === "string" && description.trim().length > 0
    && description.length <= LIMITS.skillDescriptionChars && !/\p{Cc}/u.test(description.replace(/[\n\r\t]/g, "")),
  "E_INTEGRITY", "Invalid skill description");
  return { entryBytes, skill: { name: name as string, description: description as string,
    body: text.slice(4 + end!.index + end![0].length) } };
};

export const validateNames = (resources: readonly VerifiedResource[]): void => {
  const names = resources.flatMap(resource => resource.skill ? [resource.skill.name] : []);
  requireValue(new Set(names).size === names.length, "E_INTEGRITY", "Skill names must be unique across all resources");
};
