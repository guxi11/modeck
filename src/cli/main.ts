import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve as absolute } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, LIMITS, modeError, parseJson, sha256 } from "../contracts/index.js";
import type { Agent, ImportConfigRequest, InstallPlan, ModeError, ResourceLock, VerifiedResourceSet } from "../contracts/index.js";
import { loadConfig, parseConfig, parseLock } from "../core/index.js";
import { importConfig, initConfig, scanHome, syncResources } from "../resources/index.js";
import { migrate } from "./migrate.js";
import { applyInstallPlan, encodeHook, planInstall, planUninstall, prepare, runAgent } from "../integration/index.js";
import { data, imageJson, object, readImage, safeAbsolute } from "../integration/fs.js";
import { parseEvent, runMarker } from "../integration/hooks.js";

const runtimeRoot = fileURLToPath(new URL("../../", import.meta.url));
const help = "modup <init|import|scan|migrate|sync|resolve|render|hook|install|uninstall|run> [options]\n"
  + "--config <dir>  --state <dir>  --agent <codex|claude>\n"
  + "init --dir <new-dir> | import --from <git-url> --dir <new-dir> [--ref HEAD]\n"
  + "scan --home <HOME> --format json | migrate --home <HOME> --config <existing-repo> [--bindings <JSON>] [--apply --expect <digest>]\n"
  + "sync [--frozen|--update] | resolve [--cwd <dir>] | render --agent <agent> [--cwd <dir>] [--format text|json]\n"
  + "hook --agent <agent> (SessionStart JSON on stdin)\n"
  + "install|uninstall --agent <agent> --target-home <HOME-root> [--format text|json] [--apply [--expect <digest>]]\n"
  + "run --agent <agent> [--cwd <dir>] [--executable <path>] -- <agent arguments>\n";
const values: Readonly<Record<string, readonly string[]>> = {
  init: ["dir"], import: ["from", "dir", "ref"], sync: ["config", "state"],
  scan: ["home", "format"], migrate: ["home", "config", "bindings", "expect", "format"],
  resolve: ["config", "state", "cwd"], render: ["config", "state", "cwd", "agent", "format"],
  hook: ["config", "state", "agent"], install: ["config", "state", "agent", "target-home", "format", "expect"],
  uninstall: ["agent", "target-home", "format", "expect"], run: ["config", "state", "cwd", "agent", "executable"],
};
const booleans: Readonly<Record<string, readonly string[]>> = { sync: ["update", "frozen"], install: ["apply"], uninstall: ["apply"], migrate: ["apply"] };
const options = (command: string, argv: readonly string[]): Readonly<Record<string, string | boolean>> => {
  const parse = (index: number, result: Readonly<Record<string, string | boolean>>): Readonly<Record<string, string | boolean>> => {
    const token = argv[index];
    if (token === undefined) return result;
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
  if (value !== "codex" && value !== "claude") throw modeError("E_USAGE", "Unknown agent");
  return value;
};
const pathFor = async (value: string): Promise<string> => safeAbsolute(absolute(value));
const json = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
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
const executableFor = async (agent: Agent, supplied?: string): Promise<string> => {
  const candidates = supplied ? [absolute(supplied)] : (process.env.PATH ?? "").split(delimiter).map(path => join(path, agent));
  const found = await candidates.reduce(async (pending, candidate) => {
    const previous = await pending;
    if (previous) return previous;
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { return null; }
  }, Promise.resolve<string | null>(null));
  if (!found) throw modeError("E_IO", "Agent executable not found", { agent });
  const self = process.argv[1] ? await realpath(process.argv[1]).catch(() => "") : "";
  if (found === self) throw modeError("E_WRAPPER_CONFLICT", "Wrapper cannot launch itself");
  return found;
};
const validateImportedLock = (lock: ResourceLock, config: Awaited<ReturnType<typeof loadConfig>>["config"]): void => {
  if (lock.resourceSpecDigest !== sha256(Buffer.from(canonical(config.resources)))
    || canonical(lock.resources.map(resource => resource.id)) !== canonical(Object.keys(config.resources).sort())
    || lock.resources.some(resource => {
      const spec = config.resources[resource.id];
      return !spec || spec.kind !== resource.kind || resource.sourceDigest !== sha256(Buffer.from(canonical(spec)))
        || (spec.source.type === "git") !== (resource.commit !== null);
    })) throw modeError("E_LOCK_MISMATCH", "Imported lock does not match configuration");
};
const showPlan = (plan: InstallPlan, format: string): void => {
  if (format === "json") { json(plan); return; }
  process.stdout.write(`${plan.operation} ${plan.agent} ${plan.targetHome}\nplan: ${plan.planDigest}\n`);
  plan.changes.forEach(change => process.stdout.write(`${change.after === null ? "delete" : change.beforeDigest === null ? "create" : "update"} ${change.path}\n`));
  plan.changes.filter(change => change.category === "shared-json").forEach(change => {
    if (change.after) process.stdout.write(`${change.path}:\n${data(change.after).toString("utf8")}\n`);
  });
  [...plan.warnings, ...plan.conflicts].forEach(item => process.stdout.write(`${item.code}: ${item.message}\n`));
};
const exitFor = (error: ModeError, hook: boolean): number => {
  if (hook) return 1;
  if (["E_INSTALL_CONFLICT", "E_PLAN_STALE", "E_BUSY"].includes(error.code)) return 4;
  if (["E_WRAPPER_CONFLICT", "E_CODEX_CONFIG", "E_HOOK_INPUT"].includes(error.code)) return 5;
  return ["E_USAGE", "E_CONFIG", "E_SELECTOR", "E_MODE_CONFLICT", "E_SCAN_LIMIT", "E_CONTEXT_SIZE", "E_LIMIT"].includes(error.code) ? 2 : 3;
};

export const main = async (argv: string[]): Promise<number> => {
  const command = argv[0] ?? "--help";
  try {
    if (command === "--help") { process.stdout.write(help); return 0; }
    if (command === "--version") { process.stdout.write(`${await packageVersion()}\n`); return 0; }
    if (Number(process.versions.node.split(".")[0]) < 20 || process.platform === "win32") throw modeError("E_PLATFORM", "Node20+ on macOS/Linux is required");
    if (!Object.hasOwn(values, command)) throw modeError("E_USAGE", "Unknown command", { command });
    const separator = argv.indexOf("--", 1);
    if (separator >= 0 && command !== "run") throw modeError("E_USAGE", "Only run accepts agent arguments");
    const opts = options(command, argv.slice(1, separator < 0 ? undefined : separator));
    if (opts.help) { process.stdout.write(help); return 0; }
    const configured = async () => ({
      configRoot: await pathFor(String(opts.config ?? process.env.MODUP_CONFIG ?? join(homedir(), ".config/modup"))),
      stateRoot: await pathFor(String(opts.state ?? process.env.MODUP_STATE ?? join(homedir(), ".local/share/modup/v1"))),
    });
    const format = String(opts.format ?? "text");
    if (!["text", "json"].includes(format)) throw modeError("E_USAGE", "Unknown output format");
    if (command === "scan") {
      json(await scanHome(await pathFor(required(opts, "home")))); return 0;
    }
    if (command === "migrate") {
      if (opts.expect !== undefined && !opts.apply) throw modeError("E_USAGE", "expect requires apply");
      if (typeof opts.bindings === "string" && Buffer.byteLength(opts.bindings) > LIMITS.jsonBytes) throw modeError("E_LIMIT", "bindings JSON exceeds byte limit");
      const result = await migrate({ home: await pathFor(required(opts, "home")), configRoot: await pathFor(required(opts, "config")),
        apply: opts.apply === true, ...(typeof opts.bindings === "string" ? { bindings: parseJson(opts.bindings) } : {}),
        ...(typeof opts.expect === "string" ? { expect: opts.expect } : {}) });
      json(result); return 0;
    }
    if (command === "init") {
      const config = parseConfig({ schemaVersion: 1, defaults: ["base"], modes: { base: {} }, resources: {} });
      json({ schemaVersion: 1, configRoot: await initConfig({ destination: await pathFor(required(opts, "dir")), initialConfig: config }) }); return 0;
    }
    if (command === "import") {
      const destination = await pathFor(required(opts, "dir"));
      const request: ImportConfigRequest = { destination, url: required(opts, "from"), ref: String(opts.ref ?? "HEAD"), validate: async stagingRoot => {
        const context = await loadConfig({ configRoot: stagingRoot });
        const image = await readImage(join(stagingRoot, "modes.lock.json"), LIMITS.lockBytes);
        if (image) validateImportedLock(parseLock(imageJson(image)), context.config);
      } };
      const imported = await importConfig(request);
      json({ schemaVersion: 1, configRoot: imported }); return 0;
    }
    if (command === "install" || command === "uninstall") {
      if (opts.expect !== undefined && !opts.apply) throw modeError("E_USAGE", "expect requires apply");
      const expected = opts.expect;
      if (expected !== undefined && (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected))) throw modeError("E_USAGE", "Invalid expected plan digest");
      const request = { agent: agentFor(opts), targetHome: await pathFor(required(opts, "target-home")) };
      const plan = command === "install" ? await planInstall({ ...request, ...await configured(), runtimeRoot }) : await planUninstall(request);
      if (opts.apply && !plan.conflicts.length) await applyInstallPlan({ plan, ...(typeof expected === "string" ? { expectDigest: expected } : {}) });
      showPlan(plan, format); return plan.conflicts.length ? 4 : 0;
    }
    const { configRoot, stateRoot } = await configured();
    if (command === "sync") {
      if (opts.update && opts.frozen) throw modeError("E_USAGE", "update and frozen are mutually exclusive");
      const result: VerifiedResourceSet = await syncResources({ context: await loadConfig({ configRoot }), stateRoot,
        mode: opts.update ? "update" : opts.frozen ? "frozen" : "reuse", parseLock });
      json({ schemaVersion: 1, configDigest: result.configDigest, lockDigest: result.lockDigest,
        resources: result.lock.resources.map(({ id, treeDigest, commit }) => ({ id, treeDigest, commit })) }); return 0;
    }
    if (command === "hook") {
      const event = parseEvent(await input());
      const normalized = { ...event, cwd: await realpath(event.cwd) };
      const { rendered } = await prepare({ agent: agentFor(opts), configRoot, stateRoot, cwd: normalized.cwd });
      const reply = encodeHook({ event: normalized, rendered, marker: runMarker(), configRoot, stateRoot });
      if (reply) json(reply); return 0;
    }
    const cwd = await realpath(absolute(String(opts.cwd ?? process.cwd())));
    if (command === "run") {
      const agent = agentFor(opts);
      const result = await runAgent({ agent, configRoot, stateRoot, cwd,
        argv: separator < 0 ? [] : argv.slice(separator + 1), executable: await executableFor(agent, typeof opts.executable === "string" ? opts.executable : undefined) });
      if (result.signal) { process.kill(process.pid, result.signal); return 1; }
      return result.exitCode ?? 1;
    }
    const prepared = await prepare({ agent: command === "resolve" ? "codex" : agentFor(opts), configRoot, stateRoot, cwd });
    if (command === "resolve") json(prepared.plan);
    else if (format === "json") json(prepared.rendered);
    else process.stdout.write(prepared.rendered.text);
    return 0;
  } catch (caught) {
    const error = caught instanceof Error && "code" in caught && String(caught.code).startsWith("E_") ? caught as ModeError
      : modeError("E_IO", "Operation failed", { cause: String(caught) });
    process.stderr.write(`${JSON.stringify({ error: { code: error.code, message: error.message, details: error.details } })}\n`);
    return exitFor(error, command === "hook");
  }
};
