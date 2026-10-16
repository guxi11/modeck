import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { Key } from "node:readline";
import checkbox from "@inquirer/checkbox";
import { modeError } from "../contracts/index.js";
import type { Agent } from "../contracts/index.js";
import { missing } from "../integration/fs.js";
import { loadRecord } from "../integration/install.js";

const agents = ["claude", "codex", "codebuddy"] as const;
const installed = async (home: string, agent: Agent): Promise<boolean> => {
  const directory = await lstat(join(home, `.${agent}`)).catch(error => {
    if (missing(error)) return null;
    throw error;
  });
  if (directory?.isDirectory()) return true;
  return (await Promise.all((process.env.PATH ?? "").split(delimiter).map(async path => {
    const executable = join(path, agent);
    try { await access(executable, constants.X_OK); return (await stat(executable)).isFile(); }
    catch (error) {
      if (missing(error) || error instanceof Error && "code" in error && ["EACCES", "ENOTDIR"].includes(String(error.code))) return false;
      throw error;
    }
  }))).some(Boolean);
};

export const selectAgents = async (operation: "bind" | "unbind", home: string): Promise<readonly Agent[]> => {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw modeError("E_USAGE", `${operation} requires a TTY for selection; use --agent <claude|codex|codebuddy>`);
  const candidates = (await Promise.all(agents.map(async agent => {
    const record = await loadRecord(home, agent);
    if (operation === "unbind" ? !record : !record && !await installed(home, agent)) return [];
    return [{ value: agent, name: `${agent} — ${record ? `bound to ${record.configRoot}` : "not bound"}`, checked: false }];
  }))).flat();
  if (!candidates.length) {
    process.stderr.write(`No ${operation === "bind" ? "installed agents" : "modup bindings"} found in ${home}; no changes made.\n`);
    return [];
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const keypress = (_: string, key: Key) => { if (key.ctrl && ["c", "d"].includes(key.name ?? "")) cancel(); };
  process.stdin.on("keypress", keypress);
  process.stdin.on("end", cancel);
  process.on("SIGINT", cancel);
  try {
    const selected = await checkbox<Agent>({ message: `Select agents to ${operation} (${home})`, choices: candidates },
      { output: process.stderr, signal: controller.signal });
    if (!selected.length) process.stderr.write("No agents selected; no changes made.\n");
    return selected;
  } catch (error) {
    if (!(error instanceof Error) || !["AbortPromptError", "ExitPromptError"].includes(error.name)) throw error;
    process.stderr.write("Selection cancelled; no changes made.\n");
    return [];
  } finally {
    process.stdin.off("keypress", keypress);
    process.stdin.off("end", cancel);
    process.off("SIGINT", cancel);
  }
};
