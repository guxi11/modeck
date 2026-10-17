import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDefinitions, LIMITS, modeError } from "../contracts/index.js";
import type { Agent, RunAgentRequest, RunResult } from "../contracts/index.js";
import { codexConfig } from "./codex.js";
import { data, imageJson, object, readImage, safeAbsolute } from "./fs.js";
import { markerText } from "./hooks.js";
import { prepare } from "./prepare.js";
import { prepareMcpLaunch } from "./mcp-launch.js";

type Parsed = { readonly rest: readonly string[]; readonly overrides: readonly string[];
  readonly cd: string | null; readonly append: string | null; readonly appendFile: string | null;
  readonly print: boolean; readonly inputFormat: string | null };

const parseArguments = (agent: Agent, argv: readonly string[]): Parsed => {
  const adapter = agentDefinitions[agent];
  const allowed: Readonly<Record<string, number>> = adapter.run.flags;
  const execFlags: Readonly<Record<string, number>> = { "--json": 0, "--skip-git-repo-check": 0, "-o": 1, "--output-last-message": 1 };
  const walk = (index: number, state: Parsed, seen: ReadonlySet<string>, exec: boolean, prompt: string | null): Parsed => {
    const token = argv[index];
    if (token === undefined) return { ...state, rest: [...state.rest, ...(prompt === null ? [] : ["--", prompt])] };
    if (token === "--") return { ...state, rest: [...state.rest, "--", ...(prompt === null ? [] : [prompt]), ...argv.slice(index + 1)] };
    if (!token.startsWith("-") || token === "-") {
      if (adapter.run.exec && ["exec", "e"].includes(token) && !exec && prompt === null) {
        return walk(index + 1, { ...state, rest: [...state.rest, token] }, seen, true, null);
      }
      if (prompt === null && (adapter.run.commands as readonly string[]).includes(token)) {
        throw modeError("E_WRAPPER_CONFLICT", "This agent subcommand cannot be wrapped; use an explicit -- for prompt data", { token });
      }
      if (prompt !== null) throw modeError("E_WRAPPER_CONFLICT", "Only one prompt argument is supported");
      return walk(index + 1, state, seen, exec, token);
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
      || /^(?:profile|model_instructions_file|instructions|mcp_servers)(?:\.|$)/.test(configKey)
      || configKey.startsWith("developer_instructions."))) throw modeError("E_WRAPPER_CONFLICT", "Unsupported Codex config override");
    const identity = configKey === null ? canonicalFlag : `config:${configKey}`;
    if (seen.has(identity)) throw modeError("E_WRAPPER_CONFLICT", "Duplicate wrapper flag", { flag });
    const tokens = argv.slice(index, next);
    const rest = canonicalFlag === "--cd" || canonicalFlag === "--no-daemon" || canonicalFlag.startsWith("--append-system-prompt")
      || configKey === "developer_instructions" ? state.rest : [...state.rest, ...tokens];
    const updated: Parsed = { rest, overrides: configKey === null ? state.overrides : [...state.overrides, "-c", value!],
      cd: canonicalFlag === "--cd" ? value! : state.cd,
      append: canonicalFlag === "--append-system-prompt" ? value! : state.append,
      appendFile: canonicalFlag === "--append-system-prompt-file" ? value! : state.appendFile,
      print: state.print || canonicalFlag === "--print",
      inputFormat: canonicalFlag === "--input-format" ? value! : state.inputFormat };
    if (updated.append !== null && updated.appendFile !== null) throw modeError("E_WRAPPER_CONFLICT", "Append prompt options are mutually exclusive");
    return walk(next, updated, new Set([...seen, identity]), exec, prompt);
  };
  return walk(0, { rest: [], overrides: [], cd: null, append: null, appendFile: null,
    print: false, inputFormat: null }, new Set(), false, null);
};

export const runAgent = async (request: RunAgentRequest): Promise<RunResult> => {
  if (process.env.MODECK_RUN_V1 !== undefined) throw modeError("E_WRAPPER_CONFLICT", "Nested wrappers are not supported");
  const { agent } = request;
  const adapter = agentDefinitions[agent];
  const configRoot = await safeAbsolute(request.configRoot);
  const stateRoot = await safeAbsolute(request.stateRoot);
  const parsed = parseArguments(agent, request.argv);
  const cwd = await realpath(request.cwd);
  const executable = await realpath(request.executable);
  if (parsed.cd !== null && await realpath(resolve(parsed.cd)) !== cwd) throw modeError("E_WRAPPER_CONFLICT", "Agent cwd conflicts with --cwd");
  const prepared = await prepare({ agent, configRoot, stateRoot, cwd,
    ...(request.configRoots === undefined ? {} : { configRoots: request.configRoots }) });
  if (agent === "codebuddy" && !parsed.print && parsed.inputFormat === "stream-json"
    && Object.keys(prepared.mcp.servers).length) {
    throw modeError("E_WRAPPER_CONFLICT", "CodeBuddy persistent stream-json does not support temporary MCP injection");
  }
  const packageImage = await readImage(fileURLToPath(new URL("../../package.json", import.meta.url)), LIMITS.jsonBytes);
  const version = packageImage ? object(imageJson(packageImage)).version : null;
  if (typeof version !== "string") throw modeError("E_IO", "Package version is unavailable");
  const baseline = adapter.run.instructionChannel === "codex-config" ? await codexConfig(executable, cwd, parsed.overrides, version) : null;
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
  const injection = adapter.run.instructionChannel === "codex-config" ? ["--no-daemon", "-C", cwd, "-c", `developer_instructions=${encoded}`]
    : ["--append-system-prompt", combined];
  const marker = markerText({ version: 1, agent, configRoot, stateRoot, cwd,
    contentDigest: prepared.rendered.contentDigest, ownerPid: process.pid });
  const mcp = await prepareMcpLaunch({ agent, cwd, servers: prepared.mcp.servers,
    ...(baseline ? { codexSnapshot: baseline.snapshot } : {}) });
  try {
    if (mcp.verify) {
      if ((await codexConfig(executable, cwd, parsed.overrides, version)).snapshot !== baseline?.snapshot) {
        throw modeError("E_CODEX_CONFIG", "Effective Codex configuration changed while preparing MCP");
      }
      mcp.verify((await codexConfig(executable, cwd, [...parsed.overrides, ...mcp.argv], version)).snapshot);
    }
    return await new Promise<RunResult>((resolveResult, reject) => {
      const child = spawn(executable, [...injection, ...mcp.argv, ...parsed.rest],
        { cwd, env: { ...process.env, MODECK_RUN_V1: marker }, stdio: "inherit", shell: false });
      const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
      const handlers = signals.map(signal => ({ signal, handler: (): void => { child.kill(signal); } }));
      handlers.forEach(({ signal, handler }) => process.on(signal, handler));
      const cleanup = (): void => { handlers.forEach(({ signal, handler }) => process.off(signal, handler)); };
      child.once("error", error => { cleanup(); reject(modeError("E_IO", "Cannot start agent", { cause: String(error) })); });
      child.once("exit", (exitCode, signal) => { cleanup(); resolveResult({ exitCode, signal }); });
    });
  } finally { await mcp.cleanup(); }
};
