import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { LIMITS, modeError } from "../contracts/index.js";
import type { Agent } from "../contracts/index.js";
import { data, missing, readImage } from "./fs.js";

const skillName = async (directory: string, fallback: string, agent: Agent): Promise<string | null> => {
  const path = await realpath(join(directory, "SKILL.md")).catch(error => {
    if (missing(error)) return null;
    throw error;
  });
  if (!path) return null;
  const image = await readImage(path, LIMITS.textFileBytes);
  if (!image) return null;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data(image)).replace(/\r\n?/g, "\n");
  const frontmatter = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!frontmatter) return agent === "codex" ? null : fallback;
  const document = parseDocument(frontmatter[1]!, { schema: "core", uniqueKeys: true });
  if (document.errors.length) return null;
  const name: unknown = document.get("name");
  const description: unknown = document.get("description");
  if (agent === "codex" && (typeof description !== "string" || !description.trim())) return null;
  return typeof name === "string" && name.trim() ? name : agent === "codex" ? null : fallback;
};

const projectDirectories = (cwd: string, boundary: string): readonly string[] =>
  cwd === boundary || dirname(cwd) === cwd ? [cwd] : [cwd, ...projectDirectories(dirname(cwd), boundary)];

export const nativeSkillNames = async (cwd: string, agent: Agent = "codebuddy", boundary = cwd): Promise<readonly string[]> => {
  const project = await realpath(cwd);
  const root = await realpath(boundary);
  const rel = relative(root, project);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== project) {
    throw modeError("E_PATH", "Native skill boundary does not contain cwd");
  }
  const directory = agent === "codex" ? ".agents" : `.${agent}`;
  const configHome = process.env[agent === "codex" ? "CODEX_HOME" : agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEBUDDY_CONFIG_DIR"];
  const user = resolve(project, configHome || join(homedir(), `.${agent}`));
  const roots = [...new Set([
    // CodeBuddy loads project skills only from cwd, unlike Claude and Codex.
    ...(agent === "codebuddy" ? [project] : projectDirectories(project, root)).map(path => join(path, directory, "skills")),
    ...(agent === "codex" ? [join(homedir(), ".agents/skills"), join(user, "skills"), "/etc/codex/skills"] : [join(user, "skills")]),
  ])];
  type Scan = { readonly names: readonly string[]; readonly entries: number };
  const walk = async (base: string, directory: string, ancestors: ReadonlySet<string>, state: Scan): Promise<Scan> => {
    const path = await realpath(directory).catch(error => {
      if (missing(error)) return null;
      throw error;
    });
    if (!path || ancestors.has(path)) return state;
    if (ancestors.size >= LIMITS.scanDepth) throw modeError("E_SCAN_LIMIT", "Native skill scan depth exceeded");
    const children = await readdir(path, { withFileTypes: true });
    const entries = state.entries + children.length;
    if (entries > LIMITS.scanEntries) throw modeError("E_SCAN_LIMIT", "Native skill scan entry limit exceeded");
    return children.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).reduce(async (pending, entry) => {
      const current = await pending;
      const child = join(directory, entry.name);
      try {
        const fallback = agent === "codebuddy" ? relative(base, child).split(sep).join(":") : entry.name;
        const name = await skillName(child, fallback, agent);
        const next = { names: [...current.names, ...(name === null ? [] : [name])], entries: current.entries };
        // Supporting files inside a Codex skill are not independent skills.
        return agent === "claude" || name !== null && agent === "codex" ? next
          : await walk(base, child, new Set([...ancestors, path]), next);
      } catch (error) {
        if (missing(error) || error instanceof Error && "code" in error && error.code === "ENOTDIR") return current;
        throw error;
      }
    }, Promise.resolve({ names: state.names, entries }));
  };
  const scanned = await roots.reduce(async (pending, path) => walk(path, path, new Set(), await pending),
    Promise.resolve({ names: [] as readonly string[], entries: 0 }));
  return [...new Set(scanned.names)].sort();
};
