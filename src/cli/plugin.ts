import { resolve } from "node:path";
import { modeError } from "../contracts/index.js";
import type { PluginAgent } from "../contracts/index.js";
import { managePlugins } from "../plugins/manage.js";
import { safeAbsolute } from "../integration/fs.js";

const actions = ["init", "status", "apply", "remove", "recover"] as const;
type Action = typeof actions[number];
const help = "Usage: modeck plugin <init|status|apply|remove|recover> --config <dir> --agent <claude|codex> --target-home <dir> --cwd <dir> [--format <text|json>]\n";
const parse = (argv: readonly string[]): { action: Action; configRoot: string; targetHome: string;
  cwd: string; agent: PluginAgent; format: "text" | "json" } => {
  const [action, ...rest] = argv;
  if (!actions.includes(action as Action)) throw modeError("E_USAGE", "Choose plugin init|status|apply|remove|recover");
  const values: Record<string, string> = {};
  const names = ["config", "target-home", "cwd", "agent", "format"];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) throw modeError("E_USAGE", "Unexpected plugin argument");
    const equal = token.indexOf("=");
    const key = token.slice(2, equal < 0 ? undefined : equal);
    if (!names.includes(key) || Object.hasOwn(values, key)) throw modeError("E_USAGE", "Unknown or duplicate plugin option");
    const value = equal < 0 ? rest[++index] : token.slice(equal + 1);
    if (!value || value.startsWith("--")) throw modeError("E_USAGE", "Missing plugin option value", { key });
    values[key] = value;
  }
  if (values.agent !== "claude" && values.agent !== "codex") throw modeError("E_USAGE", "Choose plugin agent claude or codex");
  if (values.format !== undefined && values.format !== "text" && values.format !== "json") throw modeError("E_USAGE", "Choose --format text or json");
  for (const key of ["config", "target-home", "cwd"] as const) {
    if (!values[key]) throw modeError("E_USAGE", `Plugin --${key} is required`);
  }
  return { action: action as Action, configRoot: values.config!, targetHome: values["target-home"]!,
    cwd: values.cwd!, agent: values.agent, format: (values.format ?? "text") as "text" | "json" };
};

export const pluginCommand = async (argv: readonly string[]): Promise<number> => {
  if (argv.length === 1 && ["-h", "--help", "help"].includes(argv[0]!)) {
    process.stdout.write(help);
    return 0;
  }
  try {
    const options = parse(argv);
    const result = await managePlugins(options.action, {
      configRoot: await safeAbsolute(resolve(options.configRoot)),
      targetHome: await safeAbsolute(resolve(options.targetHome)),
      cwd: await safeAbsolute(resolve(options.cwd)), agent: options.agent,
    });
    if (options.format === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      const summary = result && typeof result === "object" && !Array.isArray(result)
        ? result as Record<string, unknown> : {};
      const lines = [`modeck plugin ${options.action}: ${String(summary.outcome ?? "complete")}`];
      if (typeof summary.agent === "string") lines.push(`Agent: ${summary.agent}`);
      if (Array.isArray(summary.plugins)) summary.plugins.forEach(value => {
        if (typeof value === "string") lines.push(`  ${value}`);
        else if (value && typeof value === "object") {
          const plugin = value as Record<string, unknown>;
          lines.push(`  ${String(plugin.id ?? plugin.name ?? "plugin")}`
            + `${typeof plugin.commit === "string" ? ` · ${plugin.commit}` : ""}`
            + `${typeof plugin.installed === "boolean" ? ` · ${plugin.installed ? "installed" : "not installed"}` : ""}`);
        }
      });
      for (const key of ["session", "trust", "auth", "observability", "message"] as const) {
        if (typeof summary[key] === "string") lines.push(`${key}: ${summary[key]}`);
      }
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Plugin operation failed";
    process.stderr.write(`modeck plugin: ${message}\n`);
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    return ["E_INSTALL_CONFLICT", "E_PLAN_STALE", "E_BUSY"].includes(code) ? 4
      : code === "E_IO" ? 3 : 2;
  }
};
