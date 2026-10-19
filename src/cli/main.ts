import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as absolute } from "node:path";
import { fileURLToPath } from "node:url";
import { agents, isAgent, LIMITS, modeError, parseJson } from "../contracts/index.js";
import type { Agent, ModeError } from "../contracts/index.js";
import { evaluateModes } from "./eval.js";
import { manageResources } from "./resource.js";
import { mcpStaticCommand } from "./mcp-static.js";
import { initialize } from "./init.js";
import { migrateHome } from "./scan.js";
import { migrate } from "./migrate.js";
import { configRootFor, projectRootFor } from "./config.js";
import { manageConfig } from "./manage-config.js";
import { configRoots } from "../integration/registry.js";
import { loadRecord } from "../integration/install.js";
import { selectAgents } from "./bind.js";
import { encodeHook, prepare } from "../integration/index.js";
import { imageJson, object, readImage, safeAbsolute } from "../integration/fs.js";
import { parseEvent } from "../integration/hooks.js";
import { createUi, UiCancelled } from "./ui.js";
import { pluginCommand } from "./plugin.js";
import type { Ui } from "./ui.js";

const runtimeRoot = fileURLToPath(new URL("../../", import.meta.url));
const agentChoices = agents.join("|");
const help = "Usage: modeck <command> [options]\n\nCommands:\n"
  + "  Setup and migration\n  init                   Initialize configuration\n  scan                   Import resources from agent homes\n"
  + "  migrate                Migrate existing configuration\n  res <init|update>       Manage external resources\n"
  + "\n  Inspect and select context\n  eval                   Evaluate automatic modes\n  save                   Save automatic modes to .modes\n"
  + "  resolve                Explain resolved modes, plugins, rules and skills\n  render                 Render context\n"
  + "\n  Configuration and sessions\n  register               Register a configuration\n  unregister             Unregister a configuration\n"
  + "  config                 Manage registered configurations\n"
  + "  mcp <migrate|apply|status|recover>\n    Manage static native MCP configuration\n"
  + "  plugin <init|status|apply|remove|recover>\n    Manage pinned native plugins\n"
  + "\n  Agent protocol (internal)\n  hook                   Handle agent session hook input/output\n\n"
  + "Native SessionStart adapters are verified with Qwen Code >= 0.25.2 and Qoder CLI >= 1.1.73.\n"
  + "Older versions are not covered by this compatibility baseline.\n\n"
  + "Options:\n  -h, --help              Show help\n  -v, --version           Show version\n";
const commandHelp: Readonly<Record<string, string>> = {
  eval: "Usage: modeck eval [--config <dir>] [--cwd <dir>] [--state <dir>] [--format <text|json>] [-h|--help]\n\n"
    + "Ignore existing .modes and evaluate configured auto selectors, defaults and inheritance.\n"
    + "Uses enabled registered configurations unless --config is supplied; --cwd defaults to the current directory.\n"
    + "Read-only: reports mode IDs, sources and reasons without installing resources or creating state.\n"
    + "Compares the automatic result with the actual current .modes selection; a non-empty .modes disables auto-detected modes while defaults and inheritance still apply.\n"
    + "Auto selectors execute as trusted user code. --state only identifies a directory to exclude from project facts.\n",
  resolve: "Usage: modeck resolve [--config <dir>] [--cwd <dir>] [--state <dir>] [--format <text|json>] [-h|--help]\n\n"
    + "Explain the final modes, plugins, rules and skills selected for the current directory, including each mode's selection reason.\n"
    + "Prepares and compiles context, validating installed resources and using the configured state/cache directory; run modeck res init if a declared resource is missing. This is not a pure parse-only operation.\n"
    + "Text output is concise. JSON returns the complete resolved plan. In non-TTY use without --format, JSON is retained for compatibility; pass --format text to request text.\n",
  save: "Usage: modeck save [--config <dir>] [--cwd <dir>] [--state <dir>] [--format <text|json>] [--yes] [-h|--help]\n\n"
    + "Evaluate as eval does, then atomically save the fixed mode IDs to the Git repository root .modes.\n"
    + "Outside Git, the destination is --cwd (default: current directory). Defaults still apply when resolving.\n"
    + "Always previews old and new contents on stderr. Existing files require a TTY confirmation (default No),\n"
    + "or explicit --yes to overwrite, including in non-TTY use. Missing files can be created without a TTY.\n"
    + "Empty results, nearer .modes overrides and selections that cannot be faithfully fixed are refused without writing.\n"
    + "--format selects text or JSON output; --config, --cwd and --state have the same meaning as eval.\n",
  init: `Usage: modeck init [--agent <${agentChoices}>] [--home <dir>] [--config <dir>] [--list | --answers <file>] [-h|--help]\n`,
  scan: `Usage: modeck scan [--agent <${agentChoices}>] [--home <dir>] [--config <dir>] [--list | --answers <file>] [-h|--help]\n`,
  migrate: "Usage: modeck migrate [--config <dir>] [--mode <name>] [--list | --answers <file>] [-h|--help]\n",
  register: "Usage: modeck register [--config <dir>] [--target-home <dir>] [-h|--help]\n",
  unregister: "Usage: modeck unregister [--config <dir>] [--target-home <dir>] [-h|--help]\n",
  config: "Usage: modeck config [--list | --answers <file>] [--target-home <dir>] [--state <dir>] [--dry-run] [--expect <digest>] [-h|--help]\n",
  resource: "Usage: modeck res <init|update> [--config <dir>] [-h|--help]\n",
};
const values: Readonly<Record<string, readonly string[]>> = {
  eval: ["config", "cwd", "state", "format"], save: ["config", "cwd", "state", "format"],
  resource: ["config"],
  init: ["home", "answers", "agent", "config"], scan: ["home", "answers", "agent", "config"], migrate: ["config", "state", "answers", "mode"],
  resolve: ["config", "state", "cwd", "format"], render: ["config", "state", "cwd", "agent", "format"],
  hook: ["config", "state", "agent"], register: ["config", "target-home"], unregister: ["config", "target-home"],
  config: ["answers", "target-home", "state", "expect", "format"],
};
const booleans: Readonly<Record<string, readonly string[]>> = { save: ["yes"], init: ["list"], scan: ["list"], migrate: ["list"], config: ["list", "dry-run"] };
const options = (command: string, argv: readonly string[]): Readonly<Record<string, string | boolean>> => {
  const parse = (index: number, result: Readonly<Record<string, string | boolean>>): Readonly<Record<string, string | boolean>> => {
    const token = argv[index];
    if (token === undefined) return result;
    if (token === "-h" && !Object.hasOwn(result, "help")) return parse(index + 1, { ...result, help: true });
    if (!token.startsWith("--")) throw modeError("E_USAGE", "Unexpected positional argument", { token });
    const equal = token.indexOf("=");
    const key = token.slice(2, equal < 0 ? undefined : equal);
    if (Object.hasOwn(result, key)) throw modeError("E_USAGE", "Duplicate option", { key });
    if (key === "help" && equal < 0) return parse(index + 1, { ...result, help: true });
    if (booleans[command]?.includes(key) && equal < 0) return parse(index + 1, { ...result, [key]: true });
    if (!values[command]?.includes(key)) throw modeError("E_USAGE", "Unknown option", { key });
    const value = equal < 0 ? argv[index + 1] : token.slice(equal + 1);
    if (value === undefined || !value || equal < 0 && value.startsWith("--")) throw modeError("E_USAGE", "Missing option value", { key });
    return parse(index + (equal < 0 ? 2 : 1), { ...result, [key]: value });
  };
  return parse(0, {});
};
const required = (opts: Readonly<Record<string, string | boolean>>, name: string): string => {
  const value = opts[name];
  if (typeof value !== "string") throw modeError("E_USAGE", "Required option missing", { name });
  return value;
};
const agentFor = (opts: Readonly<Record<string, string | boolean>>): Agent => {
  const value = required(opts, "agent");
  if (!isAgent(value)) throw modeError("E_USAGE", `Unknown agent; choose ${agentChoices}`);
  return value;
};
const pathFor = async (value: string): Promise<string> => safeAbsolute(absolute(value));
const json = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
const items = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];
const resolvedIdLabels = (ids: readonly string[]): ReadonlyMap<string, string> => {
  const hashes = [...new Set(ids.flatMap(id => {
    const match = /^([0-9a-f]{64}):/u.exec(id);
    return match ? [match[1]!] : [];
  }))];
  const lengths = new Map(hashes.map(hash => [hash, 8]));
  while (hashes.some(hash => hashes.some(other => hash !== other
    && hash.slice(0, lengths.get(hash)!) === other.slice(0, lengths.get(hash)!)))) {
    hashes.forEach(hash => lengths.set(hash, Math.min(64, lengths.get(hash)! + 4)));
  }
  return new Map(ids.flatMap(id => {
    const match = /^([0-9a-f]{64}):(.*)$/u.exec(id);
    return match ? [[id, `${match[2]} [${match[1]!.slice(0, lengths.get(match[1]!)!)}]`] as const] : [];
  }));
};
const reportImport = (command: string, value: unknown, ui: Ui): void => {
  const result = object(value);
  if (typeof result.message === "string") { process.stdout.write(`${result.message}\n`); return; }
  const count = items(result.resources).length;
  const unchanged = command !== "init" && count === 0;
  const lines = [unchanged ? "No resources selected; no changes made." : `Configuration:\n  ${result.configRoot}`];
  if (typeof result.backupDirectory === "string") lines.push(`Backups:\n  ${result.backupDirectory}`);
  if (items(result.retained).length) lines.push(`Retained ${items(result.retained).length} managed/shared entries.`);
  ui.section(`modeck ${command}: ${unchanged ? "no changes" : command === "init" ? "initialized" : "imported"} · ${count} resources`, lines.join("\n"));
};
const reportConfig = (command: string, result: Readonly<Record<string, unknown>>, ui: Ui): void => {
  if (command !== "config") {
    ui.section(`modeck ${command}`, result.changed ? "Configuration updated." : "No changes made.");
    return;
  }
  const enabled = items(result.projects).filter(project => object(project).enabled).length;
  const operations: string[] = [];
  for (const value of items(result.plans)) {
    const plan = object(value);
    if (!result.conflicts) operations.push(`  ${plan.agent}: ${plan.operation === "bind" ? "bound" : "unbound"}`);
    for (const value of [...items(plan.conflicts), ...items(plan.warnings)]) {
      const diagnostic = object(value);
      ui.printError(`${plan.agent}: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`);
    }
  }
  ui.section("Configuration result", result.conflicts ? "Conflicts found; no changes made."
    : [`${enabled} configuration${enabled === 1 ? "" : "s"} enabled.`, ...operations].join("\n"));
};
const packageVersion = async (): Promise<string> => {
  const image = await readImage(join(runtimeRoot, "package.json"), LIMITS.jsonBytes);
  const version = image ? object(imageJson(image)).version : undefined;
  if (typeof version !== "string") throw modeError("E_IO", "Package metadata is unavailable");
  return version;
};
const input = async (): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += bytes.length;
    if (length > LIMITS.hookInputBytes) throw modeError("E_HOOK_INPUT", "Hook input byte limit exceeded");
    chunks.push(bytes);
  }
  try { return parseJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))); }
  catch { throw modeError("E_HOOK_INPUT", "Hook input must be valid JSON"); }
};
const exitFor = (error: ModeError, hook: boolean): number => {
  if (hook) return 1;
  if (["E_INSTALL_CONFLICT", "E_PLAN_STALE", "E_BUSY"].includes(error.code)) return 4;
  if (error.code === "E_HOOK_INPUT") return 5;
  return ["E_USAGE", "E_CONFIG", "E_SELECTOR", "E_MODE_CONFLICT", "E_SCAN_LIMIT", "E_CONTEXT_SIZE", "E_LIMIT"].includes(error.code) ? 2 : 3;
};

export const main = async (argv: string[]): Promise<number> => {
  const command = argv[0] === "res" ? "resource" : argv[0] ?? "--help";
  try {
    if (command === "--help" || command === "-h") { process.stdout.write(help); return 0; }
    if (command === "--version" || command === "-v") { process.stdout.write(`${await packageVersion()}\n`); return 0; }
    const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
    if (major < 22 || major === 22 && minor < 20 || process.platform === "win32") {
      throw modeError("E_PLATFORM", "Node22.20.0+ on macOS/Linux is required");
    }
    if (command === "mcp") return mcpStaticCommand(argv.slice(1));
    if (command === "plugin") return pluginCommand(argv.slice(1));
    if (!Object.hasOwn(values, command)) throw modeError("E_USAGE", "Unknown command", { command });
    const hasAction = command === "resource" && argv[1] !== undefined && !argv[1].startsWith("-");
    const opts = options(command, argv.slice(hasAction ? 2 : 1));
    if (opts.help) { process.stdout.write(commandHelp[command] ?? help); return 0; }
    if (command === "resource") {
      await manageResources(await pathFor(String(opts.config ?? process.cwd())), argv[1] ?? ""); return 0;
    }
    const configured = async (single = false, agent?: Agent) => {
      const record = agent === undefined ? null : await loadRecord(homedir(), agent);
      const explicit = typeof opts.config === "string" ? opts.config : undefined;
      const configRoot = await (single ? projectRootFor : configRootFor)(homedir(), process.cwd(), explicit);
      const roots = command === "resolve" && !record ? await configRoots(configRoot) : [];
      const fallback = command === "resolve" && !record
        ? (await Promise.all(agents.map(agent => loadRecord(homedir(), agent))))
          .find(candidate => candidate && (candidate.configRoot === configRoot || roots.includes(candidate.configRoot)))
        : record;
      return { configRoot, stateRoot: await pathFor(String(opts.state ?? process.env.MODECK_STATE ?? fallback?.stateRoot ?? join(homedir(), ".local/share/modeck/v1"))) };
    };
    const format = String(opts.format ?? (command === "resolve" && !process.stdout.isTTY ? "json" : "text"));
    if (!["text", "json"].includes(format)) throw modeError("E_USAGE", "Unknown output format");
    const ui = createUi({ format: format === "json" || opts.list === true ? "json" : "text" });
    if (command === "eval" || command === "save") {
      const cwd = await realpath(absolute(String(opts.cwd ?? process.cwd())));
      const configRoot = await configRootFor(homedir(), cwd, typeof opts.config === "string" ? opts.config : undefined);
      const stateRoot = await pathFor(String(opts.state ?? process.env.MODECK_STATE ?? join(homedir(), ".local/share/modeck/v1")));
      await evaluateModes({ command, configRoot, stateRoot, cwd, format, yes: opts.yes === true });
      return 0;
    }
    if (command === "init" || command === "scan") {
      if (opts.list && opts.answers) throw modeError("E_USAGE", "--list and --answers cannot be combined");
      const result = await (command === "init" ? initialize : migrateHome)(await pathFor(process.cwd()), await pathFor(String(opts.home ?? homedir())), {
        list: opts.list === true, ...(typeof opts.answers === "string" ? { answers: await pathFor(opts.answers) } : {}),
        ...(opts.agent !== undefined ? { agent: agentFor(opts) } : {}),
        ...(typeof opts.config === "string" ? { configRoot: await pathFor(opts.config) } : {}),
      });
      if (opts.list) json(result); else reportImport(command, result, ui);
      return 0;
    }
    if (command === "migrate") {
      if (opts.list && opts.answers) throw modeError("E_USAGE", "--list and --answers cannot be combined");
      const result = await migrate({ cwd: await realpath(process.cwd()), ...await configured(true),
        list: opts.list === true, ...(typeof opts.answers === "string" ? { answers: await pathFor(opts.answers) } : {}),
        ...(typeof opts.mode === "string" ? { mode: opts.mode } : {}) });
      if (opts.list) json(result); else reportImport(command, result, ui);
      return 0;
    }
    if (command === "register" || command === "unregister" || command === "config") {
      const nonInteractive = !process.stdin.isTTY || !process.stderr.isTTY;
      if (command === "config" && !opts.list && typeof opts.answers !== "string"
        && (format === "json" || opts["dry-run"] === true && nonInteractive)) {
        throw modeError("E_USAGE", "JSON config output requires --answers <file>; use --list to inspect without applying answers");
      }
      const result = await manageConfig(command, await pathFor(String(opts["target-home"] ?? homedir())), process.cwd(), runtimeRoot, opts, ui);
      if (opts.list || opts["dry-run"] || format === "json") json(result); else reportConfig(command, result, ui);
      return result.conflicts ? 4 : 0;
    }
    if (command === "render" && format === "json" && opts.agent === undefined) throw modeError("E_USAGE", `Choose an agent with --agent ${agentChoices}; JSON output cannot prompt`);
    const selectedAgent = command === "resolve" ? "codex" : opts.agent !== undefined ? agentFor(opts)
      : command === "render" ? (await selectAgents("render", await pathFor(homedir()), ui))[0] : undefined;
    if (command === "render" && !selectedAgent) return 0;
    const { configRoot, stateRoot } = await configured(false, selectedAgent);
    if (command === "hook") {
      const agent = agentFor(opts);
      const event = parseEvent(await input(), agent);
      const normalized = { ...event, cwd: await realpath(event.cwd) };
      const { rendered } = await prepare({ agent, configRoot, stateRoot, cwd: normalized.cwd });
      const reply = encodeHook({ rendered });
      rendered.filtered.forEach(item => process.stderr.write(`modeck: omitted ${item.kind} already present natively: ${item.id} (${item.basis})\n`));
      json(reply); return 0;
    }
    const cwd = await realpath(absolute(String(opts.cwd ?? process.cwd())));
    const agent = selectedAgent;
    if (!agent) return 0;
    const prepared = await prepare({ agent, configRoot, stateRoot, cwd });
    if (command === "resolve") {
      if (format === "json") json(prepared.plan);
      else {
        const plan = prepared.plan;
        const labels = resolvedIdLabels([...plan.modeIds, ...plan.resources.map(resource => resource.id),
          ...plan.pluginIds,
          ...plan.reasons.flatMap(reason => [reason.mode, ...(reason.from === null ? [] : [reason.from])])]);
        const label = (id: string): string => labels.get(id) ?? id;
        const ordered = (ids: readonly string[]): string => ids.length ? ids.map((id, index) => `${index + 1}. ${label(id)}`).join("\n") : "(none)";
        const rules = plan.resources.filter(resource => resource.kind === "rule").map(resource => resource.id);
        const skills = plan.resources.filter(resource => resource.kind === "skill").map(resource => resource.id);
        ui.section(`Resolved context · ${plan.modeIds.length} mode${plan.modeIds.length === 1 ? "" : "s"}`,
          [`Directory: ${plan.cwd}`, `Boundary: ${plan.boundary}`, `Selector: ${plan.selectorPath ?? "(none; defaults and auto)"}`].join("\n"));
        ui.section(`Modes · ${plan.modeIds.length}`, ordered(plan.modeIds));
        ui.section(`Selected plugins · ${plan.pluginIds.length}`, ordered(plan.pluginIds));
        ui.section(`Rules · ${rules.length}`, ordered(rules));
        ui.section(`Skills · ${skills.length}`, ordered(skills));
        if (plan.reasons.length) ui.section("Selection reasons", plan.reasons.map(reason =>
          `  ${label(reason.mode)}: ${reason.via}${reason.from === null ? "" : ` (${label(reason.from)})`}`).join("\n"));
        if (plan.diagnostics.length) ui.section("Diagnostics", plan.diagnostics.map(item =>
          `  ${item.code}: ${item.message}${item.path ? ` (${item.path})` : ""}`).join("\n"));
      }
    }
    else if (format === "json") {
      const { modeIds: _modeIds, ...rendered } = prepared.rendered;
      json(rendered);
    }
    else process.stdout.write(prepared.rendered.text);
    return 0;
  } catch (caught) {
    if (caught instanceof UiCancelled) return 130;
    const error = caught instanceof Error && "code" in caught && String(caught.code).startsWith("E_") ? caught as ModeError
      : modeError("E_IO", "Operation failed");
    const safeDetails = ["agent", "configRoot", "cwd", "path", "target", "name", "key", "cause"].flatMap(key => {
      const value = error.details[key];
      return typeof value === "string" && value.length <= 500 && !/[\r\n]/u.test(value) ? [`${key}: ${value}`] : [];
    });
    process.stderr.write(`modeck: ${error.message} [${error.code}]${safeDetails.length ? `\n${safeDetails.map(value => `  ${value}`).join("\n")}` : ""}\n`);
    return exitFor(error, command === "hook");
  }
};
