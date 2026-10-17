import { homedir } from "node:os";
import { resolve } from "node:path";
import { modeError } from "../contracts/index.js";
import type { StaticMcpRequest, StaticMcpSummary } from "../contracts/mcp-static.js";
import { safeAbsolute } from "../integration/fs.js";
import { manageStaticMcp } from "../mcp/manage.js";

const help = "Usage: modeck mcp <migrate|apply|status|recover> --agent <claude|codex> --scope <user|project> [--config <dir>] [--target-home <dir>] [--cwd <dir>] [--format <text|json>]\n\n"
  + "Central source: <config>/modeck-mcp.yaml; --config defaults to the current directory. No modes, hooks, registry combination or run integration.\n"
  + "  migrate  Copy safely representable native definitions into central configuration and explicitly enroll successful imports/matches for management in one transaction; never alter native bytes. Literal credentials, nonempty arguments, credential-like URL paths, unsupported fields and owned drift are rejected per server.\n"
  + "  apply    Atomically merge central definitions; preserve unmanaged and centrally removed servers, reject conflicts/drift without changing the native batch.\n"
  + "           Matching unmanaged entries are not adopted by apply; use explicit migrate before centrally updating an existing native source.\n"
  + "  status   Show a credential-free apply plan; no writes.\n"
  + "  recover  Roll back an interrupted transaction, or finish committed cleanup. Use the original agent, scope, home, cwd and configuration.\n\n"
  + "Claude: user .claude.json (inside CLAUDE_CONFIG_DIR when explicitly set); project <cwd>/.mcp.json. Local definitions stay native.\n"
  + "Codex: user <home>/.codex/config.toml only. Native profiles/project configuration exist but writes to them are outside this implementation; no app-server dependency. SSE and environment-variable renaming are refused.\n"
  + "Codex named *.config.toml profile files are inspected for name conflicts and directory changes, not written. Legacy [profiles.name] tables are preserved but not treated as active MCP layers. Only native commands without --profile or -c/--config overrides are covered by the default-user visibility contract.\n"
  + "CodeBuddy: not supported in this phase; candidate-file priority and shared project files require a separately verified adapter.\n"
  + "Claude project creation is refused when it would shadow CodeBuddy's existing mcp.json fallback. Existing .mcp.json is shared native configuration, not agent isolation.\n"
  + "--target-home defaults to HOME; alternate CLAUDE_CONFIG_DIR/CODEX_HOME overrides are refused. All supplied directories must already exist.\n"
  + "References: env/header values must be { env: ENV_NAME }; actual environment values are never read or materialized. Native policy, approvals, authentication and connectivity remain agent responsibilities.\n"
  + "Claude remote headers: known credential references that Claude reads as empty are refused; other references still require native authentication verification. Use a dedicated variable name.\n"
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
const report = (summary: StaticMcpSummary, json: boolean): void => {
  if (json) { process.stdout.write(`${JSON.stringify(summary)}\n`); return; }
  const { counts } = summary;
  process.stdout.write(`modeck mcp ${summary.action}: ${summary.outcome}\nAdded ${counts.added}; updated ${counts.updated}; matched ${counts.matched}; preserved ${counts.preserved}; rejected ${counts.rejected}.\n${summary.message}\n`);
  if (summary.target) process.stdout.write(`Native target: ${summary.target}\nCentral configuration: ${summary.configuration}\n`);
  for (const decision of summary.decisions) process.stdout.write(`  ${decision.name}: ${decision.action} — ${decision.reason}\n`);
  process.stdout.write(`Next: ${summary.next}\n`);
};
export const mcpStaticCommand = async (argv: readonly string[]): Promise<number> => {
  const action = argv[0] ?? "help";
  if (["help", "--help", "-h"].includes(action) || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(help); return 0;
  }
  let json = argv.some(token => token === "--format=json") || argv.some((token, index) => token === "--format" && argv[index + 1] === "json");
  let agent = "unknown"; let scope = "unknown";
  try {
    if (!["migrate", "apply", "status", "recover"].includes(action)) throw modeError("E_USAGE", "Unknown MCP action; use mcp --help");
    const opts = options(argv.slice(1));
    if (opts.format !== undefined && !["text", "json"].includes(opts.format)) throw modeError("E_USAGE", "Unknown MCP output format");
    json = opts.format === "json";
    if (opts.agent === "codebuddy") throw modeError("E_USAGE", "CodeBuddy is not supported in this phase: candidate-file priority and shared project files require a separately verified adapter");
    if (opts.agent !== "claude" && opts.agent !== "codex") throw modeError("E_USAGE", "MCP requires --agent claude|codex");
    agent = opts.agent;
    if (opts.scope !== "user" && opts.scope !== "project") throw modeError("E_USAGE", "MCP requires explicit --scope user|project");
    scope = opts.scope;
    const request: StaticMcpRequest = {
      agent: opts.agent, scope: opts.scope,
      targetHome: await safeAbsolute(resolve(opts["target-home"] ?? homedir())),
      configRoot: await safeAbsolute(resolve(opts.config ?? process.cwd())),
      cwd: await safeAbsolute(resolve(opts.cwd ?? process.cwd())),
    };
    const result = await manageStaticMcp(action as "migrate" | "apply" | "status" | "recover", request);
    report(result, json);
    return result.outcome === "partial" ? 6 : result.outcome === "failed" ? 4 : 0;
  } catch (caught) {
    const known = caught instanceof Error && "code" in caught && /^E_(?:CONFIG|USAGE|PATH|LIMIT|INSTALL_CONFLICT|PLAN_STALE|BUSY)$/u.test(String(caught.code));
    const code = known ? String(caught.code) : "E_IO";
    // Never include native parser diagnostics, child process output, values or filesystem exception text.
    const message = known ? (caught as Error).message : "MCP operation failed; inspect directory permissions and native configuration locally";
    report({ action: ["migrate", "apply", "status", "recover"].includes(action) ? action : "unknown", outcome: "failed", agent, scope,
      counts: { added: 0, updated: 0, matched: 0, preserved: 0, rejected: 1 }, decisions: [], message: `${message} [${code}]`,
      next: ["E_BUSY", "E_INSTALL_CONFLICT", "E_PLAN_STALE"].includes(code)
        ? "Inspect the native configuration and run mcp status; if an interrupted transaction is reported, run mcp recover with its original options."
        : "Correct the reported input or permissions and retry; use mcp --help. Native credentials are never printed." }, json);
    return ["E_BUSY", "E_INSTALL_CONFLICT", "E_PLAN_STALE"].includes(code) ? 4 : code === "E_IO" ? 3 : 2;
  }
};
