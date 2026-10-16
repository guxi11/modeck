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
