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

const matchSequence = <T>(tokens: readonly (T | null)[], values: readonly string[],
  accepts: (token: T, value: string) => boolean): boolean => {
  const initial = [true, ...values.map(() => false)];
  const last = tokens.reduce((previous, token) => {
    // A wildcard consumes zero or more values: propagate reachable prefixes once, without backtracking.
    if (token === null) {
      let reachable = false;
      return previous.map(value => (reachable ||= value));
    }
    return previous.map((_, index) => index > 0 && previous[index - 1]!
      && accepts(token, values[index - 1]!));
  }, initial);
  return last[values.length]!;
};

export const glob = (pattern: string): { readonly test: (path: string) => boolean } => {
  const parts = pattern.split("/").map(part => part === "**" ? null
    : [...part].map(character => character === "*" ? null : character));
  // Apply the same bounded DP to path segments and Unicode characters: O(pattern length * path length).
  return { test: path => matchSequence(parts, path.split("/"), (characters, segment) =>
    matchSequence(characters, [...segment], (character, value) => character === value)) };
};
