import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import {
  canonical, checkRelativePath, LIMITS, modeError, parseJson, sha256,
} from "../contracts/index.js";
import type {
  Config, Mode, ResourceLock, ResourceSpec, Selector, ModeErrorCode,
} from "../contracts/index.js";
import { compare, copyJson, immutable, requireValue } from "./values.js";

type ModeInput = Omit<Mode, "extends" | "priority" | "rules" | "skills"> & {
  readonly extends?: readonly string[];
  readonly priority?: number;
  readonly rules?: readonly string[];
  readonly skills?: readonly { readonly id: string; readonly preload?: boolean }[];
};
type ConfigInput = Omit<Config, "defaults" | "modes"> & {
  readonly defaults?: readonly string[];
  readonly modes: Readonly<Record<string, ModeInput>>;
};
type SelectorInput = { readonly schemaVersion: 1; readonly auto?: boolean;
  readonly add?: readonly string[]; readonly disable?: readonly string[] };

const ajv = new Ajv2020({ strict: true, allErrors: true });
const schema = <T>(name: string): ValidateFunction<T> => ajv.compile<T>(parseJson(
  readFileSync(new URL(`../../schemas/${name}.schema.json`, import.meta.url), "utf8"),
) as object);
const configSchema = schema<ConfigInput>("modes");
const selectorSchema = schema<SelectorInput>("selector");
const lockSchema = schema<ResourceLock>("lock");

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
    requireValue(new Set(mode.skills.map(skill => skill.id)).size === mode.skills.length,
      "E_CONFIG", "Duplicate skill binding", { mode: id });
    [...mode.rules.map(resource => ({ id: resource, kind: "rule" })),
      ...mode.skills.map(resource => ({ id: resource.id, kind: "skill" }))].forEach(binding => {
      requireValue(config.resources[binding.id]?.kind === binding.kind, "E_CONFIG", "Missing or wrong-kind resource", { mode: id, ...binding });
    });
    mode.detect?.any.forEach(condition => {
      if (condition.type === "dependency") return;
      const path = condition.type === "exists" ? condition.path : condition.pattern;
      checkRelativePath(path, false);
      if (condition.type === "glob") requireValue(!/[?\[\]{}!()|]/.test(path)
        && path.split("/").every(part => !part.includes("**") || part === "**"),
      "E_CONFIG", "Unsupported glob", { pattern: path });
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
  const config: Config = {
    schemaVersion: 1,
    defaults: [...input.defaults ?? []],
    resources: input.resources,
    modes: Object.fromEntries(Object.entries(input.modes).map(([id, mode]) => [id, {
      extends: [...mode.extends ?? []], priority: mode.priority ?? 0,
      ...(mode.detect ? { detect: mode.detect } : {}),
      rules: [...mode.rules ?? []],
      skills: (mode.skills ?? []).map(skill => ({ id: skill.id, preload: skill.preload ?? false })),
    }])),
  };
  Object.values(config.resources).forEach(checkSource);
  checkGraph(config);
  return immutable(config);
};

export const parseSelector = (value: unknown): Selector => {
  const input = validated(value, selectorSchema, "E_SELECTOR");
  return immutable({ schemaVersion: 1 as const, auto: input.auto ?? true,
    add: [...input.add ?? []], disable: [...input.disable ?? []] });
};

export const parseLock = (value: unknown): ResourceLock => {
  const lock = validated(value, lockSchema, "E_LOCK_MISMATCH");
  const ids = lock.resources.map(resource => resource.id);
  requireValue(ids.every((id, index) => index === 0 || compare(ids[index - 1]!, id) < 0),
    "E_LOCK_MISMATCH", "Lock resources must be unique and sorted");
  const totalBytes = lock.resources.reduce((total, resource) => {
    const paths = resource.entries.map(entry => entry.path);
    const entries = new Map(resource.entries.map(entry => [entry.path, entry]));
    requireValue(new Set(paths.map(path => path.toLowerCase())).size === paths.length,
      "E_LOCK_MISMATCH", "Resource tree has case-folded path collisions", { id: resource.id });
    const bytes = resource.entries.reduce((sum, entry, index) => {
      checkRelativePath(entry.path, false);
      requireValue(index === 0 || compare(paths[index - 1]!, entry.path) < 0,
        "E_LOCK_MISMATCH", "Tree entries must be unique and sorted", { id: resource.id });
      const parent = posix.dirname(entry.path);
      requireValue(parent === "." || entries.get(parent)?.kind === "directory",
        "E_LOCK_MISMATCH", "Missing tree parent directory", { id: resource.id, path: entry.path });
      requireValue(entry.kind !== "file" || Number.isSafeInteger(entry.bytes) && entry.bytes <= LIMITS.fileBytes,
        "E_LIMIT", "Resource file exceeds byte limit", { id: resource.id, path: entry.path });
      return sum + (entry.kind === "file" ? entry.bytes : 0);
    }, 0);
    requireValue(bytes <= LIMITS.treeBytes, "E_LIMIT", "Resource tree exceeds byte limit", { id: resource.id });
    const entryPath = resource.kind === "rule" ? "content.md" : "SKILL.md";
    const main = entries.get(entryPath);
    requireValue(main?.kind === "file" && main.bytes <= LIMITS.textFileBytes,
      "E_LOCK_MISMATCH", "Missing or oversized resource entry file", { id: resource.id });
    requireValue(resource.kind !== "rule" || resource.entries.length === 1,
      "E_LOCK_MISMATCH", "Rule tree must contain only content.md", { id: resource.id });
    const digest = sha256(Buffer.from(`modup-tree-v1\n${canonical(resource.entries)}`));
    requireValue(digest === resource.treeDigest, "E_LOCK_MISMATCH", "Tree manifest digest mismatch", { id: resource.id });
    return total + bytes;
  }, 0);
  requireValue(totalBytes <= LIMITS.allResourceBytes, "E_LIMIT", "Total resource byte limit exceeded");
  return immutable(lock);
};
