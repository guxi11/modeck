import checkbox, { Separator } from "@inquirer/checkbox";
import { createInterface } from "node:readline";
import type { Key } from "node:readline";
import { LIMITS, modeError, parseJson } from "../contracts/index.js";
import type { ScanResult } from "../resources/scan.js";
import { regularBytes, requireValue, utf8 } from "../resources/fs.js";

export type Choice = { readonly id: string; readonly name: string };
const validName = (name: string): boolean => /^[a-z][a-z0-9-]{0,63}$/.test(name);
const cancelled = () => modeError("E_USAGE", "Selection cancelled; no resources were moved");

export const choose = async <T>(message: string, choices: readonly (Separator | { readonly name: string; readonly value: T; readonly description?: string })[]): Promise<readonly T[]> => {
  requireValue(process.stdin.isTTY && process.stderr.isTTY, "E_USAGE", "Selection requires a TTY; use --agent and --answers, or --list");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const keypress = (_: string, key: Key) => { if (key.ctrl && ["c", "d"].includes(key.name ?? "")) cancel(); };
  process.stdin.on("keypress", keypress);
  process.stdin.on("end", cancel);
  process.on("SIGINT", cancel);
  try {
    return await checkbox<T>({ message, choices: [...choices], pageSize: Math.max(4, Math.min(14, (process.stderr.rows ?? 24) - 9)),
      loop: false, instructions: "\n↑↓ navigate · Space select · a all · Enter continue",
      theme: { style: { renderSelectedChoices: (selected: readonly unknown[]) => `${selected.length} selected` } } }, { output: process.stderr, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && ["AbortPromptError", "ExitPromptError"].includes(error.name)) throw cancelled();
    throw error;
  } finally {
    process.stdin.off("keypress", keypress);
    process.stdin.off("end", cancel);
    process.off("SIGINT", cancel);
  }
};

export const selections = async (scan: ScanResult, answers?: string, preview?: (choices: readonly Choice[]) => Promise<string>): Promise<readonly Choice[]> => {
  if (answers !== undefined) {
    const value = parseJson(utf8((await regularBytes(answers, LIMITS.jsonBytes)).bytes)) as Record<string, unknown>;
    requireValue(value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === 1 && Array.isArray(value.resources), "E_USAGE", "Answers must be {resources:[{id,name?}]}");
    const choices = (value.resources as unknown[]).map(item => {
      requireValue(item && typeof item === "object" && !Array.isArray(item), "E_USAGE", "Invalid resource answer");
      const entry = item as Record<string, unknown>;
      requireValue(Object.keys(entry).every(key => ["id", "name"].includes(key)) && typeof entry.id === "string"
        && (entry.name === undefined || typeof entry.name === "string"), "E_USAGE", "Invalid resource answer");
      return { id: entry.id as string, name: (entry.name ?? entry.id) as string };
    });
    requireValue(choices.every(choice => scan.resources.some(resource => resource.id === choice.id) && validName(choice.name))
      && new Set(choices.map(choice => choice.id)).size === choices.length
      && new Set(choices.map(choice => choice.name.toLowerCase())).size === choices.length,
    "E_USAGE", "Answers contain unknown IDs, invalid names or duplicates");
    return choices;
  }
  const compact = (text: string): string => text.replace(/\s+/g, " ").trim();
  const ids = await choose("1/3 · Select resources to import", (["rule", "skill"] as const).flatMap(kind => {
    const resources = scan.resources.filter(resource => resource.kind === kind);
    return resources.length ? [new Separator(`── ${kind === "rule" ? "Rules" : "Skills"} (${resources.length}) ──`),
      ...resources.map(resource => ({ value: resource.id, name: resource.id,
        description: `${compact(resource.description).slice(0, 180)}\nSource: ${resource.aliases.join(", ")}` }))] : [];
  }));
  if (!ids.length) return [];
  const terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const lines = terminal[Symbol.asyncIterator]();
  let interrupted = false;
  terminal.on("SIGINT", () => { interrupted = true; terminal.close(); });
  const ask = async (prompt: string): Promise<string> => {
    process.stderr.write(prompt);
    const answer = await lines.next();
    if (answer.done || interrupted) throw cancelled();
    return answer.value.trim();
  };
  try {
    process.stderr.write("\n2/3 · Resource names\nPress Enter to keep each name.\n");
    const choices = await ids.reduce(async (pending, id) => {
      const choices = await pending;
      const nameFor = async (): Promise<string> => {
        const name = await ask(`Name for ${id} [${id}]: `) || id;
        if (validName(name) && !choices.some(choice => choice.name === name)) return name;
        process.stderr.write("Invalid or duplicate name; use lowercase letters, digits and hyphens, starting with a letter.\n");
        return nameFor();
      };
      return [...choices, { id, name: await nameFor() }];
    }, Promise.resolve([] as readonly Choice[]));
    process.stderr.write(`\n3/3 · Review ${choices.length} resources\n${choices.map(choice => `  ${choice.id}${choice.id === choice.name ? "" : ` → ${choice.name}`}`).join("\n")}\n\n`);
    if (preview) process.stderr.write(`${await preview(choices)}\n`);
    if (!/^(?:y|yes)$/i.test(await ask("Move selected resources after verifying all destinations? [y/N]: "))) throw cancelled();
    return choices;
  } finally { terminal.close(); }
};
