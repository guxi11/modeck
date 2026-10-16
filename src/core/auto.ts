import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { LIMITS, modeError } from "../contracts/index.js";
import type { ProjectFacts } from "../contracts/index.js";

// The worker isolates module caches, not permissions: this is trusted user code.
const loader = `
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
const sources = new Map();
export function initialize({ port }) {
  port.on('message', () => port.postMessage([...sources.values()]));
  port.unref();
}
export async function load(url, context, next) {
  const result = await next(url, context);
  if (url.startsWith('file:')) {
    const path = fileURLToPath(url);
    const bytes = result.source ?? await readFile(path);
    sources.set(url, { path, digest: createHash('sha256').update(bytes).digest('hex') });
  }
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
  const auto = module.default;
  if (typeof auto !== 'function') throw new Error('Auto selector must export a function');
  const autoModeIds = auto && workerData.facts ? await auto(workerData.facts) : undefined;
  const sources = await new Promise(resolve => { port1.once('message', resolve); port1.postMessage(null); });
  // Node20's CJS loader does not route transitive require() calls through ESM load hooks.
  const { readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const graph = new Map(sources.map(source => [source.path, source]));
  await Promise.all(Object.keys(require.cache).filter(path => !graph.has(path)).map(async path => {
    graph.set(path, { path, digest: createHash('sha256').update(await readFile(path)).digest('hex') });
  }));
  parentPort.postMessage({ sources: [...graph.values()], ...(autoModeIds !== undefined ? { autoModeIds } : {}),
    invalidAuto: Boolean(auto && workerData.facts && autoModeIds === undefined) });
})().catch(error => parentPort.postMessage({ error: String(error?.message ?? error) }));
`;

export type AutoSelection = { readonly sources: readonly { readonly path: string; readonly digest: string }[];
  readonly autoModeIds?: unknown; readonly invalidAuto?: boolean; readonly error?: string };

export const automaticModes = async (path: string, facts?: ProjectFacts): Promise<AutoSelection> =>
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
      reject(modeError("E_CONFIG", "Trusted automatic mode selector exceeded its execution timeout", { path }));
    }, LIMITS.probeTimeoutMs);
    thread.once("message", (result: AutoSelection) => {
      clearTimeout(timer);
      void thread.terminate();
      if (result.error) reject(modeError("E_CONFIG", "Cannot execute trusted automatic mode selector", { path, cause: result.error }));
      else resolve(result);
    });
    thread.once("error", error => { clearTimeout(timer); reject(modeError("E_CONFIG", "Cannot execute trusted automatic mode selector", { path, cause: error.message })); });
    thread.once("exit", code => { clearTimeout(timer); reject(modeError("E_CONFIG", "automatic mode selector worker exited before returning a selection", { path, exitCode: code })); });
  });
