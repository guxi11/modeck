import { homedir } from "node:os";
import { lstat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { modeError } from "../contracts/index.js";
import type { StaticMcpAgent, StaticMcpRequest, StaticMcpScope, StaticMcpSummary } from "../contracts/mcp-static.js";
import { missing, safeAbsolute } from "../integration/fs.js";
import { manageStaticMcp } from "../mcp/manage.js";
import { locate } from "../mcp/native.js";
import { createUi, UiCancelled } from "./ui.js";

const actions = ["migrate", "apply", "status", "recover"] as const;
type Action = typeof actions[number];
const help = "Usage: modeck mcp [migrate|apply|status|recover] [--agent <claude|codex>] [--scope <user|project>] [--config <dir|modeck-mcp.json|modeck-mcp.yaml>] [--target-home <dir>] [--cwd <dir>] [--format <text|json>]\n\n"
  + "Omitted action, agent or scope is selected interactively in a TTY. Defaults: current action prompt, current directory, HOME.\n"
  + "Central source: modeck-mcp.json, an independent agent-native JSON file. JSON takes precedence when both files exist; mode YAML files are never used. --config accepts its explicit path or an existing directory.\n"
  + "  migrate  Import native definitions and enroll them for management while preserving native bytes. Converts a legacy modeck-mcp.yaml source to private JSON; the YAML remains as an inactive compatibility copy.\n"
  + "  apply    Merge central definitions into native configuration; preserve unmanaged and centrally removed servers, reject conflicts/drift without changing the native batch.\n"
  + "  status   Show a credential-free apply plan; no writes.\n"
  + "  recover  Roll back an interrupted transaction, or finish committed cleanup. Use the original agent, scope, home, cwd and configuration.\n\n"
  + "Claude: user .claude.json (inside CLAUDE_CONFIG_DIR when explicitly set); project <cwd>/.mcp.json. Local definitions stay native.\n"
  + "Codex: user <home>/.codex/config.toml only. Native profiles/project configuration exist but writes to them are outside this implementation; no app-server dependency. Codex supports user scope here.\n"
  + "Codex named *.config.toml profile files are inspected for name conflicts and directory changes, not written. Legacy [profiles.name] tables are preserved but not treated as active MCP layers. Only native commands without --profile or -c/--config overrides are covered by the default-user visibility contract.\n"
  + "CodeBuddy: not supported in this phase; candidate-file priority and shared project files require a separately verified adapter.\n"
  + "Claude project creation is refused when it would shadow CodeBuddy's existing mcp.json fallback. Existing .mcp.json is shared native configuration, not agent isolation.\n"
  + "--target-home defaults to HOME; alternate CLAUDE_CONFIG_DIR/CODEX_HOME overrides are refused. All supplied directories must already exist.\n"
  + "schemaVersion 2 stores portable env/header references in servers and native definitions under agents.<agent>.mcpServers/mcp_servers. Native fields are preserved verbatim. Actual environment values are never read.\n"
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
  if (["modeck-mcp.json", "modeck-mcp.yaml"].includes(basename(path)) && (!stat || stat.isFile())) return dirname(path);
  throw modeError("E_USAGE", "MCP --config requires an existing directory or modeck-mcp.json/modeck-mcp.yaml file; mode YAML files are not supported");
};
const report = (summary: StaticMcpSummary, json: boolean): void => {
  if (json) { process.stdout.write(`${JSON.stringify(summary)}\n`); return; }
  const ui = createUi();
  const stream = process.stdout;
  const { counts } = summary;
  const outcome = ui.emphasize(summary.outcome, stream, summary.outcome === "success" ? "green" : "red");
  ui.section(`modeck mcp ${summary.action}  ${outcome}`, "");
  ui.section("Summary", [`Added ${counts.added} · Updated ${counts.updated} · Matched ${counts.matched} · Preserved ${counts.preserved} · Rejected ${counts.rejected}`,
    summary.message, ...(summary.target ? [`Native: ${summary.target}`, `Central: ${summary.configuration}`] : [])].join("\n"));
  const ordered = [...summary.decisions].sort((left, right) => Number(right.action === "rejected") - Number(left.action === "rejected"));
  if (ordered.length) ui.section("Servers", ordered.map(decision => {
    const state = decision.action === "rejected" ? ui.emphasize(decision.action, stream, "red") : decision.action;
    return decision.action === "rejected" ? `  ${decision.name}  ${state}\n    ${decision.reason}` : `  ${decision.name}  ${state}`;
  }).join("\n"));
  ui.section("Next step", ui.emphasize(summary.next, stream, "cyan"));
};
const review = (action: Action, request: StaticMcpRequest, target: string, ui: ReturnType<typeof createUi>): void => {
  ui.section("Review MCP operation", `  Operation: ${action}\n  Native path: ${target}\n  Config: ${request.configRoot}/modeck-mcp.json (preferred); ${request.configRoot}/modeck-mcp.yaml (used only when JSON is absent)`, process.stderr);
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
    const ui = createUi({ format: json ? "json" : "text" });
    if (opts.agent === "codebuddy") throw modeError("E_USAGE", "CodeBuddy is not supported in this phase: candidate-file priority and shared project files require a separately verified adapter");
    if (opts.agent !== undefined && opts.agent !== "claude" && opts.agent !== "codex") throw modeError("E_USAGE", "Choose --agent claude or codex");
    if (opts.scope !== undefined && opts.scope !== "user" && opts.scope !== "project") throw modeError("E_USAGE", "Choose --scope user or project");
    if (opts.agent === "codex" && opts.scope === "project") throw modeError("E_USAGE", "Codex project scope is not supported by this command; use --scope user");
    const interactive = process.stdin.isTTY && process.stderr.isTTY && !json;
    if (!action || action === "unknown") {
      if (!interactive) throw modeError("E_USAGE", "Choose an action: modeck mcp <migrate|apply|status|recover> [--agent claude|codex] [--scope user|project]; interactive selection requires a TTY and text output");
      usedInteraction = true;
      action = await ui.select("Choose an MCP action", actions.map(value => ({ name: value, value })));
    }
    if (!opts.agent) {
      if (!interactive) throw modeError("E_USAGE", "Choose an agent with --agent claude|codex; interactive selection requires a TTY and text output");
      usedInteraction = true;
      agent = await ui.select("Choose an agent", (["claude", "codex"] as const).map(value => ({ name: value, value })));
    } else agent = opts.agent;
    if (agent === "codex" && opts.scope === "project") throw modeError("E_USAGE", "Codex project scope is not supported by this command; use --scope user");
    if (!opts.scope) {
      if (!interactive) throw modeError("E_USAGE", `Choose a scope with --scope ${agent === "codex" ? "user" : "user|project"}; interactive selection requires a TTY and text output`);
      usedInteraction = true;
      scope = await ui.select(agent === "codex" ? "Codex MCP supports this scope" : "Choose a Claude MCP scope",
        (agent === "codex" ? ["user"] as const : ["user", "project"] as const).map(value => ({ name: value, value })));
    } else scope = opts.scope;
    if (agent === "codex" && scope !== "user") throw modeError("E_USAGE", "Codex project scope is not supported by this command; use --scope user");
    const request: StaticMcpRequest = {
      agent, scope,
      targetHome: await safeAbsolute(resolve(opts["target-home"] ?? homedir())),
      configRoot: await configurationDirectory(opts.config ?? process.cwd()),
      cwd: await safeAbsolute(resolve(opts.cwd ?? process.cwd())),
    };
    if (!json) review(action, request, (await locate(request, false)).path, ui);
    if (usedInteraction && ["migrate", "apply", "recover"].includes(action)) {
      if (!await ui.confirm("This operation writes configuration?", false)) throw new UiCancelled();
    }
    const result = await manageStaticMcp(action, request);
    report(result, json);
    return result.outcome === "partial" ? 6 : result.outcome === "failed" ? 4 : 0;
  } catch (caught) {
    const cancelled = caught instanceof UiCancelled;
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
