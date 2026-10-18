import { LIMITS, modeError, parseJson } from "../contracts/index.js";
import { createUi, Separator, UiCancelled } from "./ui.js";
import type { Ui, UiChoice } from "./ui.js";
import type { ScanResult } from "../resources/scan.js";
import { regularBytes, requireValue, utf8 } from "../resources/fs.js";

export type Choice = { readonly id: string; readonly name: string };
const validName = (name: string): boolean => /^[a-z][a-z0-9-]{0,63}$/.test(name);
const cancelled = () => modeError("E_USAGE", "Selection cancelled; no resources were moved");

export const choose = async <T>(message: string, choices: readonly (Separator | UiChoice<T>)[], ui: Ui = createUi()): Promise<readonly T[]> => {
  try {
    return await ui.checkbox<T>(message, choices, { pageSize: Math.max(4, Math.min(14, (process.stderr.rows ?? 24) - 9)),
      loop: false, instructions: "\n↑↓ navigate · Space select · a all · Enter continue",
      theme: { style: { renderSelectedChoices: (selected: readonly unknown[]) => `${selected.length} selected` } } },
    "Selection requires a TTY; use --agent and --answers, or --list");
  } catch (error) {
    if (error instanceof UiCancelled) throw cancelled();
    throw error;
  }
};

export const selections = async (scan: ScanResult, answers?: string, preview?: (choices: readonly Choice[]) => Promise<string>, rename = true): Promise<readonly Choice[]> => {
  const ui = createUi();
  if (answers !== undefined) {
    const value = parseJson(utf8((await regularBytes(answers, LIMITS.jsonBytes)).bytes)) as Record<string, unknown>;
    requireValue(value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === 1 && Array.isArray(value.resources), "E_USAGE", rename ? "Answers must be {resources:[{id,name?}]}" : "Answers must be {resources:[{id}]}");
    const choices = (value.resources as unknown[]).map(item => {
      requireValue(item && typeof item === "object" && !Array.isArray(item), "E_USAGE", "Invalid resource answer");
      const entry = item as Record<string, unknown>;
      requireValue(Object.keys(entry).every(key => ["id", "name"].includes(key)) && typeof entry.id === "string"
        && (entry.name === undefined || typeof entry.name === "string"), "E_USAGE", "Invalid resource answer");
      requireValue(rename || entry.name === undefined, "E_USAGE", "init does not accept resource names; use {id} only");
      return { id: entry.id as string, name: (entry.name ?? entry.id) as string };
    });
    requireValue(choices.every(choice => scan.resources.some(resource => resource.id === choice.id) && validName(choice.name))
      && new Set(choices.map(choice => choice.id)).size === choices.length
      && new Set(choices.map(choice => choice.name.toLowerCase())).size === choices.length,
    "E_USAGE", "Answers contain unknown IDs, invalid names or duplicates");
    return choices;
  }
  const compact = (text: string): string => text.replace(/\s+/g, " ").trim();
  const ids = await choose(`1/${rename ? 3 : 2} · Select resources to import`, (["rule", "skill"] as const).flatMap(kind => {
    const resources = scan.resources.filter(resource => resource.kind === kind);
    return resources.length ? [new Separator(`── ${kind === "rule" ? "Rules" : "Skills"} (${resources.length}) ──`),
      ...resources.map(resource => ({ value: resource.id, name: resource.id,
        description: `${compact(resource.description).slice(0, 180)}\nSource: ${resource.aliases.join(", ")}` }))] : [];
  }), ui);
  if (!ids.length) return [];
  try {
    if (rename) ui.printError("\n2/3 · Resource names\nPress Enter to keep each name.");
    const choices = rename ? await ids.reduce(async (pending, id) => {
      const choices = await pending;
      const name = await ui.input(`Name for ${id}`, id, value => validName(value) && !choices.some(choice => choice.name === value)
        || "Invalid or duplicate name; use lowercase letters, digits and hyphens, starting with a letter.");
      return [...choices, { id, name }];
    }, Promise.resolve([] as readonly Choice[])) : ids.map(id => ({ id, name: id }));
    ui.printError(`\n${rename ? "3/3" : "2/2"} · Review ${choices.length} resources\n${choices.map(choice => `  ${choice.id}${choice.id === choice.name ? "" : ` → ${choice.name}`}`).join("\n")}\n`);
    if (preview) ui.printError(await preview(choices));
    if (!await ui.confirm("Move selected resources after verifying all destinations?", false)) throw cancelled();
    return choices;
  } catch (error) { if (error instanceof UiCancelled) throw cancelled(); throw error; }
};
