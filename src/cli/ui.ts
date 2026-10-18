import checkbox from "@inquirer/checkbox";
import confirmPrompt from "@inquirer/confirm";
import inputPrompt from "@inquirer/input";
import selectPrompt from "@inquirer/select";
import { Separator } from "@inquirer/checkbox";
import type { Key } from "node:readline";
import { modeError } from "../contracts/index.js";

export { Separator };
export class UiCancelled extends Error { constructor() { super("Interactive operation cancelled"); this.name = "UiCancelled"; } }
export type UiChoice<T> = { readonly name: string; readonly value: T; readonly description?: string; readonly checked?: boolean };
export type CheckboxOptions<T> = Omit<NonNullable<Parameters<typeof checkbox<T>>[0]>, "message" | "choices">;
type PromptContext = NonNullable<Parameters<typeof checkbox>[1]>;
type UiFormat = "text" | "json";
type Style = "bold" | "green" | "red" | "cyan";
type UiOptions = { readonly format?: UiFormat };

export const createUi = ({ format = "text" }: UiOptions = {}) => {
  const styles = (stream: NodeJS.WriteStream) => {
    const enabled = stream.isTTY && process.env.NO_COLOR === undefined;
    const wrap = (code: string, close: string) => (value: string): string => enabled ? `\u001b[${code}m${value}\u001b[${close}m` : value;
    return { bold: wrap("1", "22"), green: wrap("32", "39"), red: wrap("31", "39"), cyan: wrap("36", "39") };
  };
  const emphasize = (value: string, stream: NodeJS.WriteStream, style: Style = "bold"): string => styles(stream)[style](value);
  const section = (title: string, content: string, stream: NodeJS.WriteStream = process.stdout): void => {
    stream.write(`${emphasize(title, stream)}\n${content}\n`);
  };
  const prompt = async <T>(run: (context: PromptContext) => Promise<T>, missingMessage?: string): Promise<T> => {
    const isTty = process.stdin.isTTY && process.stderr.isTTY;
    if (format === "json" || !isTty) {
      throw modeError("E_USAGE", missingMessage ?? `Interactive input is unavailable${format === "json" ? " in JSON mode" : " without a TTY"}; provide the required options`);
    }
    if (process.stdin.readableEnded || process.stdin.destroyed || process.stdin.closed) throw new UiCancelled();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const keypress = (_: string, key: Key) => { if (key.ctrl && ["c", "d"].includes(key.name ?? "")) cancel(); };
    const originalRaw = process.stdin.isRaw === true;
    process.stdin.on("keypress", keypress); process.stdin.on("end", cancel); process.on("SIGINT", cancel);
    const context: PromptContext = { output: process.stderr, signal: controller.signal };
    let failed = false;
    try { return await run(context); }
    catch (error) {
      failed = true;
      if (error instanceof Error && ["AbortPromptError", "ExitPromptError"].includes(error.name)) throw new UiCancelled();
      throw error;
    } finally {
      process.stdin.off("keypress", keypress); process.stdin.off("end", cancel); process.off("SIGINT", cancel);
      if (process.stdin.isTTY && process.stdin.isRaw !== originalRaw) {
        try { process.stdin.setRawMode(originalRaw); }
        catch (error) { if (!failed) throw error; }
      }
    }
  };
  return {
    select: <T>(message: string, choices: readonly UiChoice<T>[]): Promise<T> =>
      prompt(context => selectPrompt({ message, choices: [...choices] }, context)),
    checkbox: <T>(message: string, choices: readonly (UiChoice<T> | Separator)[], options: CheckboxOptions<T> = {}, missingMessage?: string): Promise<readonly T[]> =>
      prompt(context => checkbox<T>({ message, choices: [...choices], ...options }, context), missingMessage),
    input: (message: string, defaultValue?: string, validate?: (value: string) => boolean | string): Promise<string> =>
      prompt(context => inputPrompt({ message, ...(defaultValue === undefined ? {} : { default: defaultValue }), ...(validate ? { validate } : {}) }, context)),
    confirm: (message: string, defaultValue = false): Promise<boolean> =>
      prompt(context => confirmPrompt({ message, default: defaultValue }, context)),
    section,
    emphasize,
    printError: (message: string): void => { process.stderr.write(`${message}\n`); },
  };
};
export type Ui = ReturnType<typeof createUi>;
