import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { checkRelativePath, LIMITS, modeError } from "../contracts/index.js";
import type { CollectFactsRequest, ProjectFacts } from "../contracts/index.js";
import { absolute, isMissing, readJsonFile, safePath, within } from "./files.js";
import { parseSelector } from "./validation.js";
import { compare, immutable } from "./values.js";
import { regularBytes, utf8 } from "../resources/fs.js";

const execute = promisify(execFile);
const excluded = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo", ".cache", ".modeck"]);

const gitMarker = async (directory: string): Promise<string | null> => {
  try {
    const marker = await lstat(join(directory, ".git"));
    if (!marker.isDirectory() && !marker.isFile()) throw modeError("E_PATH", "Unsafe Git marker", { path: directory });
    return directory;
  } catch (error) {
    if (!isMissing(error)) throw error;
    const parent = dirname(directory);
    return parent === directory ? null : gitMarker(parent);
  }
};

const boundaryFor = async (cwd: string): Promise<string> => {
  if (!await gitMarker(cwd)) return cwd;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  try {
    const { stdout } = await execute("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, "rev-parse", "--show-toplevel"], {
      env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
      timeout: 10_000, maxBuffer: LIMITS.jsonBytes, encoding: "utf8",
    });
    const root = await realpath(stdout.replace(/\r?\n$/, ""));
    if (!within(root, cwd)) throw modeError("E_PATH", "Git boundary does not contain cwd");
    return root;
  } catch (error) {
    throw modeError("E_CONFIG", "Cannot determine Git worktree boundary", { cwd, cause: String(error) });
  }
};

const selectorAt = async (cwd: string, boundary: string): Promise<ProjectFacts["selector"]> => {
  const path = join(cwd, ".modes");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw modeError("E_SELECTOR", "Selector must be a regular file", { path });
    const { bytes } = await regularBytes(path, LIMITS.jsonBytes);
    let text: string;
    try { text = utf8(bytes).replace(/^\uFEFF/u, "").trim(); }
    catch { throw modeError("E_SELECTOR", "Selector must contain valid UTF-8", { path }); }
    return { path, value: parseSelector(text) };
  } catch (error) {
    if (!isMissing(error)) throw error;
    return cwd === boundary ? null : selectorAt(dirname(cwd), boundary);
  }
};

type Scan = { readonly files: readonly string[]; readonly entries: number };

const scanFiles = async (root: string, stateRoot: string): Promise<readonly string[]> => {
  const walk = async (directory: string, depth: number, state: Scan): Promise<Scan> => {
    if (depth > LIMITS.scanDepth) throw modeError("E_SCAN_LIMIT", "Directory depth limit exceeded", { path: directory });
    await safePath(directory);
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name));
    const count = state.entries + entries.length;
    if (count > LIMITS.scanEntries) throw modeError("E_SCAN_LIMIT", "Directory entry limit exceeded", { limit: LIMITS.scanEntries });
    return entries.reduce(async (pending, entry) => {
      const current = await pending;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() || entry.name === ".git" || path === stateRoot || entry.isDirectory() && excluded.has(entry.name)) return current;
      const rel = relative(root, path).split(sep).join("/");
      if (rel.length > LIMITS.pathLength) throw modeError("E_SCAN_LIMIT", "Scanned path is too long", { path });
      checkRelativePath(rel, false);
      if (entry.isDirectory()) return walk(path, depth + 1, current);
      if (!entry.isFile()) return current;
      if (current.files.length >= LIMITS.scanFiles) throw modeError("E_SCAN_LIMIT", "File count limit exceeded", { limit: LIMITS.scanFiles });
      return { files: [...current.files, rel], entries: current.entries };
    }, Promise.resolve({ files: state.files, entries: count }));
  };
  return [...(await walk(root, 0, { files: [], entries: 0 })).files].sort(compare);
};

const dependenciesAt = async (root: string): Promise<readonly string[]> => {
  const path = join(root, "package.json");
  try { await lstat(path); }
  catch (error) { if (isMissing(error)) return []; throw error; }
  const { value } = await readJsonFile(path, LIMITS.jsonBytes, "E_CONFIG");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw modeError("E_CONFIG", "package.json must be an object", { path });
  const record = value as Record<string, unknown>;
  const names = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(key => {
    const field = record[key];
    if (field === undefined) return [];
    if (!field || typeof field !== "object" || Array.isArray(field)
      || Object.values(field).some(version => typeof version !== "string")) {
      throw modeError("E_CONFIG", "Dependency field must be a string map", { path, field: key });
    }
    return Object.keys(field);
  });
  return [...new Set(names)].sort(compare);
};

export const collectFacts = async ({ cwd, stateRoot }: CollectFactsRequest): Promise<ProjectFacts> => {
  try {
    const directory = await realpath(absolute(cwd));
    if (!(await lstat(directory)).isDirectory()) throw modeError("E_PATH", "cwd must be a directory", { cwd });
    const boundary = await boundaryFor(directory);
    const state = absolute(stateRoot);
    // An absent state directory is normal for this read-only operation.
    const canonicalState = await safePath(state).catch(error => {
      if (isMissing(error)) return state;
      throw error;
    });
    const stateInfo = await lstat(canonicalState).catch(error => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (stateInfo && !stateInfo.isDirectory()) throw modeError("E_PATH", "State root must be a directory", { path: canonicalState });
    const selector = await selectorAt(directory, boundary);
    const files = await scanFiles(boundary, canonicalState);
    const dependencies = await dependenciesAt(boundary);
    return immutable({ cwd: directory, boundary, selector, files, dependencies });
  } catch (error) {
    if (error instanceof Error && "code" in error && String(error.code).startsWith("E_")) throw error;
    throw modeError("E_IO", "Cannot collect project facts", { cwd, cause: String(error) });
  }
};
