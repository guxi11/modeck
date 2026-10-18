import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { agentDefinitions, agents, modeError } from "../contracts/index.js";
import type { Agent } from "../contracts/index.js";
import { createUi, UiCancelled } from "./ui.js";
import type { Ui } from "./ui.js";
import { missing } from "../integration/fs.js";
import { loadRecord } from "../integration/install.js";

const installed = async (home: string, agent: Agent): Promise<boolean> => {
  const directory = await lstat(join(home, agentDefinitions[agent].configDirectory)).catch(error => {
    if (missing(error)) return null;
    throw error;
  });
  if (directory?.isDirectory()) return true;
  return (await Promise.all((process.env.PATH ?? "").split(delimiter).map(async path => {
    const executable = join(path, agentDefinitions[agent].executable);
    try { await access(executable, constants.X_OK); return (await stat(executable)).isFile(); }
    catch (error) {
      if (missing(error) || error instanceof Error && "code" in error && ["EACCES", "ENOTDIR"].includes(String(error.code))) return false;
      throw error;
    }
  }))).some(Boolean);
};

export const selectAgents = async (operation: "bind" | "unbind" | "render", home: string, ui: Ui = createUi()): Promise<readonly Agent[]> => {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw modeError("E_USAGE", `${operation} requires a TTY for selection; use --agent <${agents.join("|")}>`);
  const candidates = (await Promise.all(agents.map(async agent => {
    const record = await loadRecord(home, agent);
    if (operation === "unbind" ? !record : !record && !await installed(home, agent)) return [];
    return [{ value: agent, name: `${agent} — ${record ? `bound to ${record.configRoot}` : "not bound"}`, checked: false }];
  }))).flat();
  if (!candidates.length) {
    if (operation === "render") throw modeError("E_USAGE", `No installed or bound agents found; use --agent <${agents.join("|")}>`);
    ui.printError(`No ${operation === "bind" ? "installed agents" : "modeck bindings"} found in ${home}; no changes made.`);
    return [];
  }
  try {
    const selected = await ui.checkbox<Agent>(`Select ${operation === "render" ? "one agent" : "agents"} to ${operation} (${home})`, candidates,
      operation === "render" ? { validate: items => items.length === 1 || "Select exactly one agent to render" } : {});
    if (!selected.length) ui.printError("No agents selected; no changes made.");
    return selected;
  } catch (error) {
    if (!(error instanceof UiCancelled)) throw error;
    ui.printError("Selection cancelled; no changes made.");
    return [];
  }
};
