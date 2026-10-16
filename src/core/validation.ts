import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import {
  canonical, checkRelativePath, LIMITS, modeError, parseJson, sha256,
} from "../contracts/index.js";
import type {
  Config, Mode, ResourceManifest, ResourceSpec, Selector, ModeErrorCode,
} from "../contracts/index.js";
import { compare, copyJson, immutable, requireValue } from "./values.js";

type ModeInput = { readonly extends?: readonly string[];
  readonly rules?: readonly string[]; readonly skills?: readonly string[] };
type ConfigInput = { readonly defaults?: readonly string[]; readonly modes: Readonly<Record<string, ModeInput>>;
  readonly resources: { readonly rules?: Readonly<Record<string, string | ResourceSpec["source"]>>;
    readonly skills?: Readonly<Record<string, string | ResourceSpec["source"]>> } };
const ajv = new Ajv2020({ strict: true, allErrors: true });
const schema = <T>(name: string): ValidateFunction<T> => ajv.compile<T>(parseJson(
  readFileSync(new URL(`../../schemas/${name}.schema.json`, import.meta.url), "utf8"),
) as object);
const configSchema = schema<ConfigInput>("modes");
const manifestSchema = schema<ResourceManifest>("manifest");

const validated = <T>(value: unknown, validate: ValidateFunction<T>, code: ModeErrorCode): T => {
  let candidate: unknown;
  try { candidate = copyJson(value); }
  catch (error) { throw modeError(code, "Invalid JSON value", { cause: String(error) }); }
  if (!validate(candidate)) throw modeError(code, "JSON does not match its schema", {
    errors: validate.errors?.map(({ instancePath, keyword, message, params }) => ({ instancePath, keyword, message, params })),
  });
  return candidate;
};

const checkSource = (spec: ResourceSpec): void => {
  checkRelativePath(spec.source.path, spec.kind === "skill");
  if (spec.source.type === "local") return;
  const { url, ref } = spec.source;
  if (url.startsWith("./")) checkRelativePath(url.slice(2), false);
  else {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw modeError("E_CONFIG", "Invalid Git URL"); }
    requireValue(["https:", "ssh:"].includes(parsed.protocol) && parsed.hostname && !parsed.password
      && !parsed.search && !parsed.hash && !/\p{Cc}/u.test(url), "E_CONFIG", "Unsupported Git URL");
  }
  requireValue(ref === "HEAD" || /^[0-9a-f]{40}$/.test(ref) || (
    /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref) && !ref.includes("..")
    && !ref.includes("//") && !ref.endsWith("/") && !ref.endsWith(".")
    && ref.split("/").every(part => !part.startsWith(".") && !part.endsWith(".lock"))
  ), "E_CONFIG", "Invalid Git ref", { ref });
};

const checkGraph = (config: Config): void => {
  const ids = Object.keys(config.modes).sort(compare);
  const known = (id: string): void => requireValue(Object.hasOwn(config.modes, id), "E_CONFIG", "Unknown mode", { id });
  config.defaults.forEach(known);
  ids.forEach(id => {
    const mode = config.modes[id]!;
    mode.extends.forEach(known);
    requireValue(new Set(mode.skills).size === mode.skills.length,
      "E_CONFIG", "Duplicate skill binding", { mode: id });
    [...mode.rules.map(resource => ({ id: resource, kind: "rule" })),
      ...mode.skills.map(resource => ({ id: resource, kind: "skill" }))].forEach(binding => {
      requireValue(config.resources[binding.id]?.kind === binding.kind, "E_CONFIG", "Missing or wrong-kind resource", { mode: id, ...binding });
    });
  });
  const visit = (id: string, chain: readonly string[], done: ReadonlySet<string>): ReadonlySet<string> => {
    requireValue(!chain.includes(id), "E_CONFIG", "Mode inheritance cycle", { chain: [...chain, id] });
    if (done.has(id)) return done;
    const parents = config.modes[id]!.extends.reduce((seen, parent) => visit(parent, [...chain, id], seen), done);
    return new Set([...parents, id]);
  };
  ids.reduce((done, id) => visit(id, [], done), new Set<string>() as ReadonlySet<string>);
};

export const parseConfig = (value: unknown): Config => {
  const input = validated(value, configSchema, "E_CONFIG");
  const ruleIds = Object.keys(input.resources.rules ?? {});
  requireValue(ruleIds.length + Object.keys(input.resources.skills ?? {}).length <= LIMITS.resources, "E_LIMIT", "Too many resources");
  requireValue(!ruleIds.some(id => Object.hasOwn(input.resources.skills ?? {}, id)), "E_CONFIG", "Resource IDs must be globally unique");
  const config: Config = {
    defaults: [...input.defaults ?? []],
    resources: Object.fromEntries((["rules", "skills"] as const).flatMap(group =>
      Object.entries(input.resources[group] ?? {}).map(([id, source]) => [id,
        { kind: group === "rules" ? "rule" as const : "skill" as const,
          source: typeof source === "string" ? { type: "local" as const, path: source } : source }]))),
    modes: Object.fromEntries(Object.entries(input.modes).map(([id, mode]) => [id, {
      extends: [...mode.extends ?? []],
      rules: [...mode.rules ?? []],
      skills: [...mode.skills ?? []],
    }])),
  };
  Object.values(config.resources).forEach(checkSource);
  checkGraph(config);
  return immutable(config);
};

export const parseSelector = (text: string): Selector => {
  const content = text.replace(/^\uFEFF/u, "").trim();
  if (!content) return immutable({ auto: true, add: [] });
  const ids = content.split(/[,\r\n]+/u).map(id => id.trim()).filter(Boolean);
  requireValue(ids.length > 0 && ids.length <= LIMITS.modes && ids.every(id => /^[a-z][a-z0-9-]{0,63}$/.test(id)),
    "E_SELECTOR", "Selector must list mode IDs separated by commas or newlines");
  return immutable({ auto: false, add: [...new Set(ids)] });
};

export const parseManifest = (value: unknown): ResourceManifest => {
  const manifest = validated(value, manifestSchema, "E_MANIFEST_MISMATCH");
  const ids = manifest.resources.map(resource => resource.id);
  requireValue(ids.every((id, index) => index === 0 || compare(ids[index - 1]!, id) < 0),
    "E_MANIFEST_MISMATCH", "Manifest resources must be unique and sorted");
  const totalBytes = manifest.resources.reduce((total, resource) => {
    const paths = resource.entries.map(entry => entry.path);
    const entries = new Map(resource.entries.map(entry => [entry.path, entry]));
    requireValue(new Set(paths.map(path => path.toLowerCase())).size === paths.length,
      "E_MANIFEST_MISMATCH", "Resource tree has case-folded path collisions", { id: resource.id });
    const bytes = resource.entries.reduce((sum, entry, index) => {
      checkRelativePath(entry.path, false);
      requireValue(index === 0 || compare(paths[index - 1]!, entry.path) < 0,
        "E_MANIFEST_MISMATCH", "Tree entries must be unique and sorted", { id: resource.id });
      const parent = posix.dirname(entry.path);
      requireValue(parent === "." || entries.get(parent)?.kind === "directory",
        "E_MANIFEST_MISMATCH", "Missing tree parent directory", { id: resource.id, path: entry.path });
      requireValue(entry.kind !== "file" || Number.isSafeInteger(entry.bytes) && entry.bytes <= LIMITS.fileBytes,
        "E_LIMIT", "Resource file exceeds byte limit", { id: resource.id, path: entry.path });
      return sum + (entry.kind === "file" ? entry.bytes : 0);
    }, 0);
    requireValue(bytes <= LIMITS.treeBytes, "E_LIMIT", "Resource tree exceeds byte limit", { id: resource.id });
    const entryPath = resource.kind === "rule" ? "content.md" : "SKILL.md";
    const main = entries.get(entryPath);
    requireValue(main?.kind === "file" && main.bytes <= LIMITS.textFileBytes,
      "E_MANIFEST_MISMATCH", "Missing or oversized resource entry file", { id: resource.id });
    requireValue(resource.kind !== "rule" || resource.entries.length === 1,
      "E_MANIFEST_MISMATCH", "Rule tree must contain only content.md", { id: resource.id });
    const digest = sha256(Buffer.from(`modeck-tree-v1\n${canonical(resource.entries)}`));
    requireValue(digest === resource.treeDigest, "E_MANIFEST_MISMATCH", "Tree manifest digest mismatch", { id: resource.id });
    return total + bytes;
  }, 0);
  requireValue(totalBytes <= LIMITS.allResourceBytes, "E_LIMIT", "Total resource byte limit exceeded");
  return immutable(manifest);
};
