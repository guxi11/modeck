import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, modeError } from "../contracts/index.js";
import type { Agent, RunAgentRequest, RunResult } from "../contracts/index.js";
import { codexConfig } from "./codex.js";
import { data, imageJson, object, readImage, safeAbsolute } from "./fs.js";
import { markerText } from "./hooks.js";
import { prepare } from "./prepare.js";

const flags = {
  codex: { "-m": 1, "--model": 1, "-s": 1, "--sandbox": 1, "-a": 1, "--ask-for-approval": 1,
    "--search": 0, "--no-alt-screen": 0, "--no-daemon": 0, "-c": 1, "--config": 1, "-C": 1, "--cd": 1 },
  claude: { "-p": 0, "--print": 0, "--model": 1, "--effort": 1, "--permission-mode": 1,
    "--output-format": 1, "--input-format": 1, "--max-budget-usd": 1, "--verbose": 0,
    "--no-session-persistence": 0, "--append-system-prompt": 1, "--append-system-prompt-file": 1 },
} as const;
type Parsed = { readonly rest: readonly string[]; readonly overrides: readonly string[];
  readonly cd: string | null; readonly append: string | null; readonly appendFile: string | null };

const parseArguments = (agent: Agent, argv: readonly string[]): Parsed => {
  const allowed: Readonly<Record<string, number>> = flags[agent];
  const execFlags: Readonly<Record<string, number>> = { "--json": 0, "--skip-git-repo-check": 0, "-o": 1, "--output-last-message": 1 };
  const walk = (index: number, state: Parsed, seen: ReadonlySet<string>, exec: boolean, prompt: boolean): Parsed => {
    const token = argv[index];
    if (token === undefined) return state;
    if (token === "--") return { ...state, rest: [...state.rest, ...argv.slice(index)] };
    if (!token.startsWith("-") || token === "-") {
      if (agent === "codex" && ["exec", "e"].includes(token) && !exec && !prompt) {
        return walk(index + 1, { ...state, rest: [...state.rest, token] }, seen, true, false);
      }
      if (agent === "codex" && !exec && !prompt && ["resume", "fork", "review", "login", "logout", "app-server", "mcp", "plugin", "debug", "app", "cloud"].includes(token)) {
        throw modeError("E_WRAPPER_CONFLICT", "This Codex subcommand cannot be wrapped", { token });
      }
      if (prompt) throw modeError("E_WRAPPER_CONFLICT", "Only one prompt argument is supported");
      return walk(index + 1, { ...state, rest: [...state.rest, token] }, seen, exec, true);
    }
    const equal = token.indexOf("=");
    const flag = equal >= 0 ? token.slice(0, equal) : token;
    const arity = allowed[flag] ?? (exec ? execFlags[flag] : undefined);
    if (arity === undefined || arity === 0 && equal >= 0) throw modeError("E_WRAPPER_CONFLICT", "Unsupported wrapper argument", { flag });
    const value = arity === 1 ? equal >= 0 ? token.slice(equal + 1) : argv[index + 1] : null;
    if (arity === 1 && value === undefined) throw modeError("E_WRAPPER_CONFLICT", "Missing flag value", { flag });
    const next = index + (arity === 1 && equal < 0 ? 2 : 1);
    const canonicalFlag = ({ "-c": "--config", "-C": "--cd", "-m": "--model", "-s": "--sandbox", "-a": "--ask-for-approval", "-p": "--print", "-o": "--output-last-message" } as Readonly<Record<string, string>>)[flag] ?? flag;
    const configKey = canonicalFlag === "--config" ? value!.slice(0, value!.indexOf("=")).trim() : null;
    if (configKey !== null && (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(configKey) || !value!.includes("=")
      || /^(?:profile|model_instructions_file|instructions)(?:\.|$)/.test(configKey)
      || configKey.startsWith("developer_instructions."))) throw modeError("E_WRAPPER_CONFLICT", "Unsupported Codex config override");
    const identity = configKey === null ? canonicalFlag : `config:${configKey}`;
    if (seen.has(identity)) throw modeError("E_WRAPPER_CONFLICT", "Duplicate wrapper flag", { flag });
    const tokens = argv.slice(index, next);
    const rest = canonicalFlag === "--cd" || canonicalFlag === "--no-daemon" || canonicalFlag.startsWith("--append-system-prompt")
      || configKey === "developer_instructions" ? state.rest : [...state.rest, ...tokens];
    const updated: Parsed = { rest, overrides: configKey === null ? state.overrides : [...state.overrides, "-c", value!],
      cd: canonicalFlag === "--cd" ? value! : state.cd,
      append: canonicalFlag === "--append-system-prompt" ? value! : state.append,
      appendFile: canonicalFlag === "--append-system-prompt-file" ? value! : state.appendFile };
    if (updated.append !== null && updated.appendFile !== null) throw modeError("E_WRAPPER_CONFLICT", "Append prompt options are mutually exclusive");
    return walk(next, updated, new Set([...seen, identity]), exec, prompt);
  };
  return walk(0, { rest: [], overrides: [], cd: null, append: null, appendFile: null }, new Set(), false, false);
};

export const runAgent = async (request: RunAgentRequest): Promise<RunResult> => {
  if (process.env.AGENT_MODES_RUN_V1 !== undefined) throw modeError("E_WRAPPER_CONFLICT", "Nested wrappers are not supported");
  const { agent } = request;
  const configRoot = await safeAbsolute(request.configRoot);
  const stateRoot = await safeAbsolute(request.stateRoot);
  const parsed = parseArguments(agent, request.argv);
  const cwd = await realpath(request.cwd);
  const executable = await realpath(request.executable);
  if (parsed.cd !== null && await realpath(resolve(parsed.cd)) !== cwd) throw modeError("E_WRAPPER_CONFLICT", "Agent cwd conflicts with --cwd");
  const prepared = await prepare({ agent, configRoot, stateRoot, cwd });
  const packageImage = await readImage(fileURLToPath(new URL("../../package.json", import.meta.url)), LIMITS.jsonBytes);
  const version = packageImage ? object(imageJson(packageImage)).version : null;
  if (typeof version !== "string") throw modeError("E_IO", "Package version is unavailable");
  const baseline = agent === "codex" ? await codexConfig(executable, cwd, parsed.overrides, version) : null;
  const append = parsed.appendFile === null ? parsed.append ?? "" : await (async () => {
    const image = await readImage(resolve(cwd, parsed.appendFile!), LIMITS.wrapperInstructionBytes);
    if (!image) throw modeError("E_WRAPPER_CONFLICT", "Append prompt file does not exist");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data(image));
  })();
  const original = baseline?.instructions ?? append;
  const combined = `${original}${original ? "\n\n" : ""}${prepared.rendered.text}`;
  if (Buffer.byteLength(combined) > LIMITS.wrapperInstructionBytes || combined.includes("\0")
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(combined)) throw modeError("E_LIMIT", "Combined instructions exceed the wrapper limit");
  if (baseline && (await codexConfig(executable, cwd, parsed.overrides, version)).snapshot !== baseline.snapshot) {
    throw modeError("E_CODEX_CONFIG", "Effective Codex configuration changed during startup");
  }
  const encoded = JSON.stringify(combined);
  if (JSON.parse(encoded) !== combined) throw modeError("E_WRAPPER_CONFLICT", "Cannot encode developer instructions");
  const injection = agent === "codex" ? ["--no-daemon", "-C", cwd, "-c", `developer_instructions=${encoded}`]
    : ["--append-system-prompt", combined];
  const marker = markerText({ version: 1, agent, configRoot, stateRoot, cwd,
    contentDigest: prepared.rendered.contentDigest, ownerPid: process.pid });
  return new Promise<RunResult>((resolveResult, reject) => {
    const child = spawn(executable, [...injection, ...parsed.rest],
      { cwd, env: { ...process.env, AGENT_MODES_RUN_V1: marker }, stdio: "inherit", shell: false });
    const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = signals.map(signal => ({ signal, handler: (): void => { child.kill(signal); } }));
    handlers.forEach(({ signal, handler }) => process.on(signal, handler));
    const cleanup = (): void => { handlers.forEach(({ signal, handler }) => process.off(signal, handler)); };
    child.once("error", error => { cleanup(); reject(modeError("E_IO", "Cannot start agent", { cause: String(error) })); });
    child.once("exit", (exitCode, signal) => { cleanup(); resolveResult({ exitCode, signal }); });
  });
};
