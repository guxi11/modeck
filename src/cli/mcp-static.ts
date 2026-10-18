import { homedir } from "node:os";
import { lstat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { modeError } from "../contracts/index.js";
import type { StaticMcpAgent, StaticMcpRequest, StaticMcpScope, StaticMcpSummary } from "../contracts/mcp-static.js";
import { missing, safeAbsolute } from "../integration/fs.js";
import { manageStaticMcp } from "../mcp/manage.js";
import { locate } from "../mcp/native.js";

const actions = ["migrate", "apply", "status", "recover"] as const;
type Action = typeof actions[number];
const help = "Usage: modeck mcp [migrate|apply|status|recover] [--agent <claude|codex>] [--scope <user|project>] [--config <dir|modeck-mcp.yaml>] [--target-home <dir>] [--cwd <dir>] [--format <text|json>]\n\n"
  + "Omitted action, agent or scope is selected interactively in a TTY. Defaults: current action prompt, current directory, HOME.\n"
  + "Central source: the independent modeck-mcp.yaml file. --config accepts its explicit path or an existing directory containing it; mode YAML files are never used.\n"
  + "  migrate  Import native definitions and enroll them for management while preserving native bytes. Native fields and values are retained in an agent-specific YAML representation; YAML can contain literal credentials, so keep it in private storage.\n"
  + "  apply    Merge central definitions into native configuration; preserve unmanaged and centrally removed servers, reject conflicts/drift without changing the native batch.\n"
  + "  status   Show a credential-free apply plan; no writes.\n"
  + "  recover  Roll back an interrupted transaction, or finish committed cleanup. Use the original agent, scope, home, cwd and configuration.\n\n"
  + "Claude: user .claude.json (inside CLAUDE_CONFIG_DIR when explicitly set); project <cwd>/.mcp.json. Local definitions stay native.\n"
  + "Codex: user <home>/.codex/config.toml only. Native profiles/project configuration exist but writes to them are outside this implementation; no app-server dependency. Codex supports user scope here.\n"
  + "Codex named *.config.toml profile files are inspected for name conflicts and directory changes, not written. Legacy [profiles.name] tables are preserved but not treated as active MCP layers. Only native commands without --profile or -c/--config overrides are covered by the default-user visibility contract.\n"
  + "CodeBuddy: not supported in this phase; candidate-file priority and shared project files require a separately verified adapter.\n"
  + "Claude project creation is refused when it would shadow CodeBuddy's existing mcp.json fallback. Existing .mcp.json is shared native configuration, not agent isolation.\n"
  + "--target-home defaults to HOME; alternate CLAUDE_CONFIG_DIR/CODEX_HOME overrides are refused. All supplied directories must already exist.\n"
  + "Portable env/header references use { env: ENV_NAME }; native definitions preserve agent-specific fields. Actual environment values are never read. Native policy, approvals, authentication and connectivity remain agent responsibilities.\n"
  + "Native files are visible to native agent commands after apply. Restart sessions to load changes; no hot reload is promised.\n"
  + "All journal/native staging stays in the private modeck state directory outside Git working trees; atomic writes across filesystems are refused. Use user scope when a project is on another filesystem.\n"
  + "Kernel FD locks coordinate modeck commands on macOS/Linux; unavailable kernel locks are refused. Pause native configuration commands and editor writes during migrate/apply/recover; drift checks are optimistic and cannot guarantee atomic compare-and-swap against external writers.\n"
  + "Exit status: 0 complete, 2 usage/configuration error, 3 I/O failure, 4 conflict/busy/recovery required, 6 partially migrated.\n";
const options = (argv: readonly string[]): Readonly<Record<string, string>> => {
  const result: Record<string, string> = {};
  const names = ["agent", "scope", "config", "target-home", "cwd", "format"];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw modeError("E_USAGE", "Unexpected MCP argument; use mcp --help");
    const equal = token.indexOf("=");
    const key = token.slice(2, equal < 0 ? undefined : equal);
    if (!names.includes(key) || Object.hasOwn(result, key)) throw modeError("E_USAGE", "Unknown or duplicate MCP option; use mcp --help");
    const value = equal < 0 ? argv[++index] : token.slice(equal + 1);
    if (!value || value.startsWith("--")) throw modeError("E_USAGE", "Missing MCP option value; use mcp --help");
    result[key] = value;
  }
  return result;
};
const configurationDirectory = async (value: string): Promise<string> => {
  const path = await safeAbsolute(resolve(value));
  const stat = await lstat(path).catch(error => { if (missing(error)) return null; throw error; });
  if (stat?.isDirectory()) return path;
  if (basename(path) === "modeck-mcp.yaml" && (!stat || stat.isFile())) return dirname(path);
  throw modeError("E_USAGE", "MCP --config requires an existing directory or the independent modeck-mcp.yaml file; mode YAML files are not supported");
};
const color = process.stdout.isTTY && process.env.NO_COLOR === undefined
  ? { bold: (value: string) => `\u001b[1m${value}\u001b[22m`, green: (value: string) => `\u001b[32m${value}\u001b[39m`, red: (value: string) => `\u001b[31m${value}\u001b[39m`, cyan: (value: string) => `\u001b[36m${value}\u001b[39m` }
  : { bold: (value: string) => value, green: (value: string) => value, red: (value: string) => value, cyan: (value: string) => value };
const report = (summary: StaticMcpSummary, json: boolean): void => {
  if (json) { process.stdout.write(`${JSON.stringify(summary)}\n`); return; }
  const { counts } = summary;
  const outcome = summary.outcome === "success" ? color.green(summary.outcome) : color.red(summary.outcome);
  process.stdout.write(`${color.bold(`modeck mcp ${summary.action}`)}  ${outcome}\n\n`);
  process.stdout.write(`${color.bold("Changes")}\n  Added ${counts.added} · Updated ${counts.updated} · Matched ${counts.matched} · Preserved ${counts.preserved} · Rejected ${counts.rejected}\n\n`);
  process.stdout.write(`${color.bold("Result")}\n${summary.message}\n`);
  if (summary.target) process.stdout.write(`\n${color.bold("Target")}\n  Native: ${summary.target}\n  Central: ${summary.configuration}\n`);
  const ordered = [...summary.decisions].sort((left, right) => Number(right.action === "rejected") - Number(left.action === "rejected"));
  if (ordered.length) process.stdout.write(`\n${color.bold("Servers")}\n${ordered.map(decision => {
    const state = decision.action === "rejected" ? color.red(decision.action) : decision.action;
    return decision.action === "rejected" ? `  ${decision.name}  ${state}\n    ${decision.reason}` : `  ${decision.name}  ${state}`;
  }).join("\n")}\n`);
  process.stdout.write(`\n${color.bold("Next step")}\n${color.cyan(summary.next)}\n`);
};
const promptValue = async (question: string, choices: readonly string[], defaultIndex?: number): Promise<string> => {
  const controller = new AbortController();
  const terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const cancel = () => controller.abort();
  terminal.on("SIGINT", cancel);
  terminal.on("close", cancel);
  try {
    for (;;) {
      const answer = (await terminal.question(`${question}\n${choices.map((choice, index) => `  ${index + 1}) ${choice}`).join("\n")}\nSelect [1-${choices.length}${defaultIndex === undefined ? "" : `, default ${defaultIndex + 1}`}]: `, { signal: controller.signal })).trim();
      if (!answer && defaultIndex !== undefined) return String(defaultIndex);
      if (!answer) continue;
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= choices.length) return String(index - 1);
      process.stderr.write(`Enter a number from 1 to ${choices.length}.\n`);
    }
  } catch {
    const error = new Error("MCP interaction cancelled; no changes were made");
    error.name = "MCPInteractionCancelled";
    throw error;
  } finally {
    terminal.off("SIGINT", cancel);
    terminal.off("close", cancel);
    terminal.close();
  }
};
const select = async <T extends string>(question: string, values: readonly T[], labels = values): Promise<T> => {
  const index = Number(await promptValue(question, labels));
  return values[index]!;
};
const review = (action: Action, agent: StaticMcpAgent, scope: StaticMcpScope, request: StaticMcpRequest, target: string): void => {
  process.stderr.write(`${color.bold("Review MCP operation")}\n  Action: ${action}\n  Agent: ${agent}\n  Scope: ${scope}\n  Native target: ${target}\n  Central config: ${request.configRoot}/modeck-mcp.yaml\n`);
};
export const mcpStaticCommand = async (argv: readonly string[]): Promise<number> => {
  const requestedAction = argv[0] === "help" ? "help" : actions.includes(argv[0] as Action) ? argv[0]! : "";
  if (["help", "--help", "-h"].includes(requestedAction) || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(help); return 0;
  }
  let json = argv.some(token => token === "--format=json") || argv.some((token, index) => token === "--format" && argv[index + 1] === "json");
  let action: Action | "unknown" = requestedAction ? requestedAction as Action : "unknown";
  let agent: StaticMcpAgent | "unknown" = "unknown";
  let scope: StaticMcpScope | "unknown" = "unknown";
  let usedInteraction = false;
  try {
    const opts = options(argv.slice(requestedAction ? 1 : 0));
    if (opts.format !== undefined && !["text", "json"].includes(opts.format)) throw modeError("E_USAGE", "Unknown MCP output format; use --format text or --format json");
    json = opts.format === "json";
    if (opts.agent === "codebuddy") throw modeError("E_USAGE", "CodeBuddy is not supported in this phase: candidate-file priority and shared project files require a separately verified adapter");
    if (opts.agent !== undefined && opts.agent !== "claude" && opts.agent !== "codex") throw modeError("E_USAGE", "Choose --agent claude or codex");
    if (opts.scope !== undefined && opts.scope !== "user" && opts.scope !== "project") throw modeError("E_USAGE", "Choose --scope user or project");
    if (opts.agent === "codex" && opts.scope === "project") throw modeError("E_USAGE", "Codex project scope is not supported by this command; use --scope user");
    const interactive = process.stdin.isTTY && process.stderr.isTTY && !json;
    if (!action || action === "unknown") {
      if (!interactive) throw modeError("E_USAGE", "Choose an action: modeck mcp <migrate|apply|status|recover> [--agent claude|codex] [--scope user|project]; interactive selection requires a TTY and text output");
      usedInteraction = true;
      action = await select("Choose an MCP action", actions);
    }
    if (!opts.agent) {
      if (!interactive) throw modeError("E_USAGE", "Choose an agent with --agent claude|codex; interactive selection requires a TTY and text output");
      usedInteraction = true;
      agent = await select("Choose an agent", ["claude", "codex"] as const);
    } else agent = opts.agent;
    if (agent === "codex" && opts.scope === "project") throw modeError("E_USAGE", "Codex project scope is not supported by this command; use --scope user");
    if (!opts.scope) {
      if (!interactive) throw modeError("E_USAGE", `Choose a scope with --scope ${agent === "codex" ? "user" : "user|project"}; interactive selection requires a TTY and text output`);
      usedInteraction = true;
      scope = agent === "codex" ? await select("Codex MCP supports this scope", ["user"] as const)
        : await select("Choose a Claude MCP scope", ["user", "project"] as const);
    } else scope = opts.scope;
    if (agent === "codex" && scope !== "user") throw modeError("E_USAGE", "Codex project scope is not supported by this command; use --scope user");
    const request: StaticMcpRequest = {
      agent, scope,
      targetHome: await safeAbsolute(resolve(opts["target-home"] ?? homedir())),
      configRoot: await configurationDirectory(opts.config ?? process.cwd()),
      cwd: await safeAbsolute(resolve(opts.cwd ?? process.cwd())),
    };
    if (!json) review(action, agent, scope, request, (await locate(request, false)).path);
    if (usedInteraction && ["migrate", "apply", "recover"].includes(action)) {
      const answer = await promptValue("This operation writes configuration. Continue?", ["Continue", "Cancel"], 1);
      if (answer !== "0") {
        const error = new Error("MCP interaction cancelled; no changes were made");
        error.name = "MCPInteractionCancelled";
        throw error;
      }
    }
    const result = await manageStaticMcp(action, request);
    report(result, json);
    return result.outcome === "partial" ? 6 : result.outcome === "failed" ? 4 : 0;
  } catch (caught) {
    const cancelled = caught instanceof Error && caught.name === "MCPInteractionCancelled";
    const known = caught instanceof Error && "code" in caught && /^E_(?:CONFIG|USAGE|PATH|LIMIT|INSTALL_CONFLICT|PLAN_STALE|BUSY)$/u.test(String(caught.code));
    const code = cancelled ? "E_CANCELLED" : known ? String(caught.code) : "E_IO";
    const message = known || cancelled ? (caught as Error).message : "MCP operation failed; inspect directory permissions and native configuration locally";
    const next = code === "E_CANCELLED" ? "No changes were made. Run the command again when ready."
      : ["E_BUSY", "E_INSTALL_CONFLICT", "E_PLAN_STALE"].includes(code)
        ? "Inspect the native configuration and run mcp status; if an interrupted transaction is reported, run mcp recover with its original options."
        : code === "E_USAGE" ? "Provide or correct the action, --agent, --scope or other reported option; use mcp --help."
          : code === "E_PATH" ? "Check that the supplied home, working and configuration paths exist and are accessible, then retry."
            : code === "E_CONFIG" ? "Inspect the static MCP configuration and agent settings locally, correct them, then retry."
              : "Check configuration files, target paths and filesystem permissions locally, then retry. Sensitive values are never printed.";
    report({ action, outcome: "failed", agent, scope,
      counts: { added: 0, updated: 0, matched: 0, preserved: 0, rejected: 1 }, decisions: [], message: `${message} [${code}]`,
      next }, json);
    return code === "E_CANCELLED" ? 130 : ["E_BUSY", "E_INSTALL_CONFLICT", "E_PLAN_STALE"].includes(code) ? 4 : code === "E_IO" ? 3 : 2;
  }
};
