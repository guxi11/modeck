import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { agentDefinitions, agents, modeError } from "../contracts/index.js";
import type { Agent, BindRecord } from "../contracts/index.js";
import { createUi } from "./ui.js";
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

// Agents worth offering for selection: installed on this machine, or still bound so they can be managed after uninstall.
export const presentAgents = async (home: string): Promise<readonly { readonly agent: Agent; readonly record: BindRecord | null }[]> =>
  (await Promise.all(agents.map(async agent => {
    const record = await loadRecord(home, agent);
    return record || await installed(home, agent) ? [{ agent, record }] : [];
  }))).flat();

// Render targets exactly one agent: bound agents come first and the first of them is preselected.
export const selectRenderAgent = async (home: string, ui: Ui = createUi()): Promise<Agent> => {
  const usage = `use --agent <${agents.join("|")}>`;
  const present = await presentAgents(home);
  const ordered = [...present.filter(({ record }) => record), ...present.filter(({ record }) => !record)];
  const [first] = ordered;
  if (!first) throw modeError("E_USAGE", `No installed or bound agents found; ${usage}`);
  if (ordered.length === 1) return first.agent;
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw modeError("E_USAGE", `render requires a TTY for selection; ${usage}`);
  return ui.select("Agent to render",
    ordered.map(({ agent, record }) => ({ value: agent, name: `${agent} — ${record ? `bound to ${record.configRoot}` : "not bound"}` })), first.agent);
};
