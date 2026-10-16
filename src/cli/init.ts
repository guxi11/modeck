import { chmod, lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { modeError, LIMITS, parseJson, sha256 } from "../contracts/index.js";
import { parseConfig } from "../core/index.js";
import { checkDirectory } from "../integration/fs.js";
import { scanHome } from "../resources/scan.js";
import type { ScanResult, ScannedResource } from "../resources/scan.js";
import { exists, regularBytes, requireValue, safePath, utf8, within } from "../resources/fs.js";
import { snapshotLocal } from "../resources/tree.js";

type Choice = { readonly id: string; readonly name: string };
const validName = (name: string): boolean => /^[a-z][a-z0-9-]{0,63}$/.test(name);
const cancelled = () => modeError("E_USAGE", "Initialization cancelled; no configuration was created");

const selections = async (scan: ScanResult, answers?: string): Promise<readonly Choice[]> => {
  if (answers !== undefined) {
    const value = parseJson(utf8((await regularBytes(answers, LIMITS.jsonBytes)).bytes)) as Record<string, unknown>;
    requireValue(value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === 1 && Array.isArray(value.resources), "E_USAGE", "Answers must be {resources:[{id,name?}]}");
    const choices = (value.resources as unknown[]).map(item => {
      requireValue(item && typeof item === "object" && !Array.isArray(item), "E_USAGE", "Invalid resource answer");
      const entry = item as Record<string, unknown>;
      requireValue(Object.keys(entry).every(key => ["id", "name"].includes(key)) && typeof entry.id === "string"
        && (entry.name === undefined || typeof entry.name === "string"), "E_USAGE", "Invalid resource answer");
      return { id: entry.id as string, name: (entry.name ?? entry.id) as string };
    });
    requireValue(choices.every(choice => scan.resources.some(resource => resource.id === choice.id) && validName(choice.name))
      && new Set(choices.map(choice => choice.id)).size === choices.length
      && new Set(choices.map(choice => choice.name.toLowerCase())).size === choices.length,
    "E_USAGE", "Answers contain unknown IDs, invalid names or duplicates");
    return choices;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw modeError("E_USAGE", "init requires a TTY; use --list or --answers <file>");
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const lines = terminal[Symbol.asyncIterator]();
  let interrupted = false;
  terminal.on("SIGINT", () => { interrupted = true; terminal.close(); });
  const ask = async (prompt: string): Promise<string> => {
    process.stdout.write(prompt);
    const answer = await lines.next();
    if (answer.done || interrupted) throw cancelled();
    return answer.value.trim();
  };
  try {
    scan.resources.forEach((resource, index) => process.stdout.write(`${index + 1}. ${resource.id} [${resource.kind}] ${resource.description}\n`));
    const choose = async (): Promise<readonly ScannedResource[]> => {
      const answer = await ask("Include resources: all / none / numbers separated by spaces or commas [none]: ");
      if (!answer || answer === "none") return [];
      if (answer === "all") return scan.resources;
      const numbers = answer.split(/[\s,]+/);
      if (numbers.every(value => /^[1-9][0-9]*$/.test(value) && Number(value) <= scan.resources.length)) {
        return [...new Set(numbers.map(Number))].map(index => scan.resources[index - 1]!);
      }
      process.stdout.write("Invalid selection.\n");
      return choose();
    };
    const selected = await choose();
    return await selected.reduce(async (pending, resource) => {
      const choices = await pending;
      const nameFor = async (): Promise<string> => {
        const name = await ask(`Name for ${resource.id} [${resource.id}]: `) || resource.id;
        if (validName(name) && !choices.some(choice => choice.name === name)) return name;
        process.stdout.write("Invalid or duplicate name; use lowercase letters, digits and hyphens, starting with a letter.\n");
        return nameFor();
      };
      return [...choices, { id: resource.id, name: await nameFor() }];
    }, Promise.resolve([] as readonly Choice[]));
  } finally { terminal.close(); }
};

export const initialize = async (root: string, home: string, options: { readonly list: boolean; readonly answers?: string }): Promise<unknown> => {
  await safePath(root);
  await checkDirectory(root);
  requireValue((await lstat(root)).isDirectory(), "E_PATH", "init must run in an existing directory");
  if (!options.list && options.answers === undefined && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw modeError("E_USAGE", "init requires a TTY; use --list or --answers <file>");
  }
  const scan = await scanHome(home);
  if (options.list) return scan;
  const configPath = join(root, "modup.mjs");
  const autoPath = join(root, "auto.mjs");
  requireValue(!await exists(configPath) && !await exists(autoPath), "E_PATH", "modup.mjs or auto.mjs already exists");
  const choices = await selections(scan, options.answers);
  const directories: { path: string; ino: number; dev: number; mode: number; finalMode: number }[] = [];
  const files: { path: string; ino: number; dev: number; digest: string; mode: number }[] = [];
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  const check = () => { if (interrupted) throw cancelled(); };
  process.on("SIGINT", interrupt);
  const directory = async (path: string, mode = 0o755): Promise<void> => {
    check(); await safePath(path, true);
    if (await exists(path)) { await checkDirectory(path); return; }
    await directory(dirname(path));
    check(); await safePath(dirname(path));
    await mkdir(path, { mode: 0o700 });
    const info = await lstat(path);
    directories.push({ path, ino: info.ino, dev: info.dev, mode: 0o700, finalMode: mode });
  };
  const write = async (path: string, bytes: Uint8Array, mode: number): Promise<void> => {
    check(); await safePath(dirname(path)); await checkDirectory(dirname(path));
    const handle = await open(path, "wx", mode);
    const info = await handle.stat();
    files.push({ path, ino: info.ino, dev: info.dev, digest: sha256(bytes), mode });
    try { await handle.writeFile(bytes); await handle.chmod(mode); } finally { await handle.close(); }
    check();
  };
  try {
    const resources: { rules: Record<string, string>; skills: Record<string, string> } = { rules: {}, skills: {} };
    await choices.reduce(async (pending, choice) => {
      await pending; check();
      const resource = scan.resources.find(item => item.id === choice.id)!;
      const source = resource.sources[0]!;
      const snapshot = await snapshotLocal(source, resource.kind);
      requireValue(snapshot.treeDigest === resource.treeDigest, "E_INTEGRITY", "Resource changed after discovery", { id: choice.id });
      const group = resource.kind === "rule" ? "rules" : "skills";
      if (within(root, source)) { resources[group][choice.name] = relative(root, source); return; }
      const destination = join(root, ".modup/resources", resource.kind, choice.name);
      requireValue(!await exists(destination), "E_PATH", "Resource destination exists", { path: destination });
      await directory(destination, resource.kind === "skill" ? (await lstat(source)).mode & 0o777 : 0o755);
      await snapshot.entries.reduce(async (previous, entry) => {
        await previous;
        const target = join(destination, entry.path);
        const original = resource.kind === "rule" ? source : join(source, entry.path);
        const info = await lstat(original);
        if (entry.kind === "directory") { await directory(target, info.mode & 0o777); return; }
        await write(target, snapshot.files.get(entry.path)!.bytes, info.mode & 0o777);
      }, Promise.resolve());
      resources[group][choice.name] = relative(root, resource.kind === "rule" ? join(destination, "content.md") : destination);
    }, Promise.resolve());
    const config = { resources, defaults: ["base"], modes: { base: { rules: Object.keys(resources.rules), skills: Object.keys(resources.skills) } } };
    parseConfig(config);
    await write(autoPath, Buffer.from("export default ({ cwd, boundary, files, dependencies }) => [];\n"), 0o644);
    await write(configPath, Buffer.from(`export { default as auto } from "./auto.mjs";\n\nexport default ${JSON.stringify(config, null, 2)};\n`), 0o644);
    await [...directories].reverse().reduce(async (pending, item) => {
      await pending; check(); await safePath(item.path);
      const info = await lstat(item.path);
      requireValue(info.ino === item.ino && info.dev === item.dev && (info.mode & 0o777) === item.mode,
        "E_PATH", "Created directory changed during initialization", { path: item.path });
      await chmod(item.path, item.finalMode); item.mode = item.finalMode;
    }, Promise.resolve());
    check();
    return { configRoot: root, resources: choices.map(choice => choice.name) };
  } catch (error) {
    await directories.reduce(async (pending, item) => {
      await pending;
      try { await safePath(item.path); const info = await lstat(item.path);
        if (info.ino === item.ino && info.dev === item.dev && (info.mode & 0o777) === item.mode) await chmod(item.path, 0o700);
      } catch { /* Keep directories whose ownership or permissions changed. */ }
    }, Promise.resolve());
    await [...files].reverse().reduce(async (pending, file) => {
      await pending;
      try {
        await safePath(dirname(file.path));
        const info = await lstat(file.path);
        if (info.ino === file.ino && info.dev === file.dev && (info.mode & 0o777) === file.mode
          && sha256((await regularBytes(file.path, LIMITS.fileBytes)).bytes) === file.digest) await unlink(file.path);
      } catch { /* User changes remain untouched. */ }
    }, Promise.resolve());
    await [...directories].reverse().reduce(async (pending, item) => {
      await pending;
      try { await safePath(item.path); const info = await lstat(item.path);
        if (info.ino === item.ino && info.dev === item.dev) await rmdir(item.path);
      } catch { /* Keep nonempty or replaced directories. */ }
    }, Promise.resolve());
    throw error;
  } finally { process.off("SIGINT", interrupt); }
};
