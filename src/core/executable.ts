import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { LIMITS, modeError } from "../contracts/index.js";
import type { ProjectFacts } from "../contracts/index.js";

// The worker isolates module caches, not permissions: this is trusted user code.
const loader = `
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const sources = new Map();
export function initialize({ port }) {
  port.on('message', () => port.postMessage([...sources.values()]));
  port.unref();
}
export async function load(url, context, next) {
  const result = await next(url, context);
  if (url.startsWith('file:') && result.source != null) sources.set(url, {
    path: fileURLToPath(url), digest: createHash('sha256').update(result.source).digest('hex')
  });
  return result;
}
`;
const worker = `
const { parentPort, workerData, MessageChannel } = require('node:worker_threads');
(async () => {
  const { register } = await import('node:module');
  const { port1, port2 } = new MessageChannel();
  register(workerData.loader, { parentURL: workerData.url, data: { port: port2 }, transferList: [port2] });
  const module = await import(workerData.url);
  if (module.auto !== undefined && typeof module.auto !== 'function') throw new Error('Named auto export must be a function');
  const autoModeIds = module.auto && workerData.facts ? await module.auto(workerData.facts) : undefined;
  const sources = await new Promise(resolve => { port1.once('message', resolve); port1.postMessage(null); });
  parentPort.postMessage({ config: module.default, sources, ...(autoModeIds !== undefined ? { autoModeIds } : {}),
    invalidAuto: Boolean(module.auto && workerData.facts && autoModeIds === undefined) });
})().catch(error => parentPort.postMessage({ error: String(error?.message ?? error) }));
`;

export type ExecutableConfig = { readonly config: unknown; readonly sources: readonly { readonly path: string; readonly digest: string }[];
  readonly autoModeIds?: unknown; readonly invalidAuto?: boolean; readonly error?: string };

export const executableConfig = async (path: string, facts?: ProjectFacts): Promise<ExecutableConfig> =>
  new Promise((resolve, reject) => {
    const thread = new Worker(worker, { eval: true, execArgv: [], stdout: true, stderr: true,
      workerData: { url: pathToFileURL(path).href, loader: `data:text/javascript,${encodeURIComponent(loader)}`,
        ...(facts && facts.selector?.value.auto !== false ? { facts: {
          cwd: facts.cwd, boundary: facts.boundary, files: facts.files, dependencies: facts.dependencies,
        } } : {}) } });
    thread.stdout.resume();
    thread.stderr.resume();
    const timer = setTimeout(() => {
      void thread.terminate();
      reject(modeError("E_CONFIG", "Trusted JavaScript configuration exceeded its execution timeout", { path }));
    }, LIMITS.probeTimeoutMs);
    thread.once("message", (result: ExecutableConfig) => {
      clearTimeout(timer);
      void thread.terminate();
      if (result.error) reject(modeError("E_CONFIG", "Cannot execute trusted JavaScript configuration", { path, cause: result.error }));
      else resolve(result);
    });
    thread.once("error", error => { clearTimeout(timer); reject(modeError("E_CONFIG", "Cannot execute trusted JavaScript configuration", { path, cause: error.message })); });
    thread.once("exit", code => { clearTimeout(timer); reject(modeError("E_CONFIG", "JavaScript configuration worker exited before returning a configuration", { path, exitCode: code })); });
  });
