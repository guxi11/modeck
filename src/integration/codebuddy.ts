import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseDocument } from "yaml";
import { LIMITS, modeError } from "../contracts/index.js";
import { data, missing, readImage } from "./fs.js";

const skillName = async (directory: string): Promise<string | null> => {
  const path = await realpath(join(directory, "SKILL.md")).catch(error => {
    if (missing(error)) return null;
    throw error;
  });
  if (!path) return null;
  const image = await readImage(path, LIMITS.textFileBytes);
  if (!image) return null;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data(image)).replace(/\r\n?/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!frontmatter) return basename(directory);
  const document = parseDocument(frontmatter[1]!, { schema: "core", uniqueKeys: true });
  if (document.errors.length) return null;
  const name: unknown = document.get("name");
  return typeof name === "string" && name.trim() ? name : basename(directory);
};

export const nativeSkillNames = async (cwd: string): Promise<readonly string[]> => {
  // Native skills may be symlinked; resolve them without executing skill contents.
  let entries = 0;
  const walk = async (directory: string, ancestors: ReadonlySet<string>): Promise<readonly string[]> => {
    const path = await realpath(directory).catch(error => {
      if (missing(error)) return null;
      throw error;
    });
    if (!path || ancestors.has(path)) return [];
    if (ancestors.size >= LIMITS.scanDepth) throw modeError("E_SCAN_LIMIT", "Native skill scan depth exceeded");
    const children = await readdir(path, { withFileTypes: true });
    entries += children.length;
    if (entries > LIMITS.scanEntries) throw modeError("E_SCAN_LIMIT", "Native skill scan entry limit exceeded");
    const names = await Promise.all(children.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(async entry => {
      const child = join(directory, entry.name);
      try {
        return [await skillName(child), ...await walk(child, new Set([...ancestors, path]))].filter((name): name is string => name !== null);
      } catch (error) {
        if (missing(error) || error instanceof Error && "code" in error && error.code === "ENOTDIR") return [];
        throw error;
      }
    }));
    return names.flat();
  };
  const roots = [...new Set([join(cwd, ".codebuddy/skills"), join(homedir(), ".codebuddy/skills")])];
  return [...new Set((await Promise.all(roots.map(root => walk(root, new Set())))).flat())].sort();
};
