import { canonical, modeError } from "../contracts/index.js";
import type { DeepReadonly, ModeErrorCode } from "../contracts/index.js";

export const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export const immutable = <T>(value: T): DeepReadonly<T> => {
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    Object.values(value).forEach(child => immutable(child));
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
};

export const copyJson = (value: unknown): unknown => JSON.parse(canonical(value)) as unknown;

export const requireValue = (condition: unknown, code: ModeErrorCode, message: string,
  details: Readonly<Record<string, unknown>> = {}): void => {
  if (!condition) throw modeError(code, message, details);
};

export const glob = (pattern: string): RegExp => {
  const parts = pattern.split("/").filter((part, index, all) => part !== "**" || all[index - 1] !== "**");
  const source = parts.map((part, index) => {
    if (part === "**") return index === parts.length - 1
      ? index === 0 ? ".*" : "(?:/[^/]+)*"
      : `${index > 0 ? "/" : ""}(?:[^/]+/)*`;
    const prefix = index > 0 && parts[index - 1] !== "**" ? "/" : "";
    return prefix + part.replace(/[.+^$()|[\]{}\\?]/g, "\\$&").replace(/\*/g, "[^/]*");
  }).join("");
  return new RegExp(`^${source}$`, "u");
};
