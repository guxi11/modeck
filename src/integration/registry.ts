import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { LIMITS, modeError } from "../contracts/index.js";
import type { ConfigRegistry } from "../contracts/index.js";
import { findConfigPath } from "../core/config-file.js";
import { checkDirectory, imageJson, object, readImage, safeAbsolute } from "./fs.js";

export const registryRoot = (home: string): string => join(home, ".local/share/modeck/registry");
export const registryPath = (root: string): string => join(root, "registry.json");

export const loadRegistry = async (root: string): Promise<ConfigRegistry | null> => {
  const directory = await safeAbsolute(root);
  if (await findConfigPath(directory)) return null;
  const path = registryPath(directory);
  const image = await readImage(path, LIMITS.jsonBytes);
  if (!image) return null;
  await checkDirectory(root);
  if (image.mode !== 0o600 || (await lstat(path)).uid !== process.getuid?.()) {
    throw modeError("E_CONFIG", "Registry must be owned by this user with permissions 0600", { path });
  }
  const value = object(imageJson(image));
  if (Object.keys(value).some(key => !["schemaVersion", "projects"].includes(key)) || value.schemaVersion !== 1
    || !Array.isArray(value.projects) || value.projects.length > LIMITS.modes) {
    throw modeError("E_CONFIG", "Invalid configuration registry", { path });
  }
  const projects = value.projects.map(entry => {
    const project = object(entry);
    if (Object.keys(project).some(key => !["root", "enabled"].includes(key)) || typeof project.root !== "string"
      || project.root.length > LIMITS.pathLength || typeof project.enabled !== "boolean"
      || !isAbsolute(project.root) || /\p{Cc}/u.test(project.root) || resolve(project.root) !== project.root
      || project.root === resolve(root)) {
      throw modeError("E_CONFIG", "Invalid registered configuration project", { path });
    }
    return Object.freeze({ root: project.root, enabled: project.enabled });
  });
  if (new Set(projects.map(project => project.root)).size !== projects.length) {
    throw modeError("E_CONFIG", "Duplicate registered configuration project", { path });
  }
  return Object.freeze({ schemaVersion: 1, projects: Object.freeze(projects) });
};

export const configRoots = async (root: string): Promise<readonly string[]> => {
  const registry = await loadRegistry(root);
  return registry ? registry.projects.filter(project => project.enabled).map(project => project.root) : [root];
};
