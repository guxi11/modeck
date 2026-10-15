import { spawn } from "node:child_process";
import { canonical, LIMITS, modeError, parseJson } from "../contracts/index.js";
import { object } from "./fs.js";

export const codexConfig = async (executable: string, cwd: string, overrides: readonly string[], version: string): Promise<{
  readonly instructions: string; readonly snapshot: string;
}> => {
  const child = spawn(executable, [...overrides, "app-server", "--stdio"], { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], shell: false });
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      let buffer = "";
      let bytes = 0;
      let finished = false;
      const timer = setTimeout(() => fail(), LIMITS.probeTimeoutMs);
      const fail = (): void => { if (!finished) { finished = true; clearTimeout(timer); reject(modeError("E_CODEX_CONFIG", "Cannot read effective Codex configuration")); } };
      const send = (message: unknown): void => { child.stdin.write(`${JSON.stringify(message)}\n`); };
      child.once("error", fail); child.once("exit", () => { if (!finished) fail(); });
      child.stdin.on("error", fail); child.stderr.on("data", () => undefined);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk); buffer += chunk;
        if (bytes > LIMITS.lockBytes) { fail(); return; }
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        lines.filter(line => line.trim()).forEach(line => {
          try {
            const message = object(parseJson(line));
            if (message.id !== 1 && message.id !== 2) return;
            if (message.error || !Object.hasOwn(message, "result")) { fail(); return; }
            if (message.id === 1) { send({ method: "initialized" }); send({ id: 2, method: "config/read", params: { cwd, includeLayers: true } }); }
            else if (!finished) { finished = true; clearTimeout(timer); resolve(message.result); }
          } catch { fail(); }
        });
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "agent-modes", version }, capabilities: { experimentalApi: false } } });
    });
    const result = object(value);
    const config = object(result.config);
    const origins = object(result.origins);
    if (!Array.isArray(result.layers)) throw modeError("E_CODEX_CONFIG", "Codex config layers are unavailable");
    const layers = result.layers.map(object);
    if (layers.some(layer => layer.disabledReason !== undefined && layer.disabledReason !== null
      && typeof layer.disabledReason !== "string")) throw modeError("E_CODEX_CONFIG", "Unknown Codex layer status");
    const active = layers.filter(layer => layer.disabledReason === null || layer.disabledReason === undefined);
    active.forEach(layer => {
      if (typeof layer.version !== "string") throw modeError("E_CODEX_CONFIG", "Invalid Codex layer version");
      const settings = object(layer.config);
      if (settings.model_instructions_file !== undefined && settings.model_instructions_file !== null
        || settings.instructions !== undefined && settings.instructions !== null) throw modeError("E_CODEX_CONFIG", "Unsupported base instructions override");
    });
    const instructions = config.developer_instructions;
    if (typeof instructions !== "string" && instructions !== null && instructions !== undefined
      || instructions == null && active.some(layer => object(layer.config).developer_instructions != null)) {
      throw modeError("E_CODEX_CONFIG", "Cannot preserve effective developer instructions");
    }
    return { instructions: typeof instructions === "string" ? instructions : "", snapshot: canonical({ config, origins, layers }) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "E_CODEX_CONFIG") throw error;
    throw modeError("E_CODEX_CONFIG", "Cannot safely interpret effective Codex configuration");
  } finally {
    child.stdin.end(); child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 500); force.unref();
    child.once("close", () => clearTimeout(force));
  }
};
