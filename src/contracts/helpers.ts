import { createHash } from "node:crypto";
import { LIMITS } from "./constants.js";
import type { ModeError, ModeErrorCode, Sha256 } from "./types.js";

export const modeError = (
  code: ModeErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ModeError => Object.assign(new Error(message), { code, details: Object.freeze({ ...details }) });

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const assertString = (value: string): string => {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw modeError("E_CONFIG", "JSON contains an isolated surrogate");
  }
  return value;
};

const checkKey = (key: string): string => {
  assertString(key);
  if (forbiddenKeys.has(key)) throw modeError("E_CONFIG", "Unsafe JSON key", { key });
  return key;
};

export const sha256 = (bytes: Uint8Array): Sha256 => createHash("sha256").update(bytes).digest("hex");

export const canonical = (value: unknown): string => {
  const encode = (item: unknown, ancestors: ReadonlySet<object>): string => {
    if (item === null) return "null";
    if (typeof item === "string") return JSON.stringify(assertString(item));
    if (typeof item === "boolean") return String(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || ancestors.has(item) || ancestors.size >= 64) {
      throw modeError("E_CONFIG", "Value is not finite, acyclic JSON");
    }
    const next = new Set([...ancestors, item]);
    if (Array.isArray(item)) return `[${Array.from(item, child => encode(child, next)).join(",")}]`;
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw modeError("E_CONFIG", "Value is not a JSON object");
    }
    const record = item as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(checkKey(key))}:${encode(record[key], next)}`).join(",")}}`;
  };
  return encode(value, new Set());
};

export const checkRelativePath = (path: string, allowRoot: boolean): void => {
  const safe = typeof path === "string" && path.length > 0 && path.length <= LIMITS.pathLength
    && path === path.normalize("NFC") && !/[\\\p{Cc}]/u.test(path) && !path.startsWith("/")
    && !/^[a-z]:/i.test(path);
  if (!safe || (path !== "." || !allowRoot) && path.split("/").some(part =>
    !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw modeError("E_PATH", "Expected a safe relative POSIX path", { path });
  }
};

export const parseJson = (text: string): unknown => {
  // Cursor mutation is confined to parsing; collections use iteration to avoid
  // overflowing the call stack on valid 10,000-entry resource manifests.
  let offset = 0;
  const fail = (message: string): never => { throw modeError("E_CONFIG", message, { offset }); };
  const space = (): void => { offset += /^[\t\r\n ]*/.exec(text.slice(offset))![0].length; };
  const string = (): string => {
    const token = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(text.slice(offset));
    if (!token) return fail("Invalid JSON string");
    offset += token[0].length;
    return assertString(JSON.parse(token[0]) as string);
  };
  const value = (depth: number): unknown => {
    if (depth > 64) return fail("JSON nesting exceeds 64 levels");
    space();
    const first = text[offset];
    if (first === '"') return string();
    if (first === "{" || first === "[") {
      const object = first === "{";
      const end = object ? "}" : "]";
      const entries: [string, unknown][] = [];
      const values: unknown[] = [];
      const keys = new Set<string>();
      offset += 1;
      space();
      if (text[offset] === end) { offset += 1; return object ? Object.fromEntries(entries) : values; }
      while (offset < text.length) {
        space();
        if (object) {
          const key = checkKey(string());
          if (keys.has(key)) return fail("Duplicate JSON key");
          keys.add(key);
          space();
          if (text[offset++] !== ":") return fail("Expected JSON colon");
          entries.push([key, value(depth + 1)]);
        } else values.push(value(depth + 1));
        space();
        const separator = text[offset++];
        if (separator === end) return object ? Object.fromEntries(entries) : values;
        if (separator !== ",") return fail("Expected JSON separator");
      }
      return fail("Unterminated JSON collection");
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(offset));
    if (!token) return fail("Invalid JSON value");
    offset += token[0].length;
    const parsed: unknown = JSON.parse(token[0]);
    if (typeof parsed === "number" && !Number.isFinite(parsed)) return fail("Non-finite JSON number");
    return parsed;
  };
  const result = value(0);
  space();
  if (offset !== text.length) return fail("Trailing JSON data");
  return result;
};
