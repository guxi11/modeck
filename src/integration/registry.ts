import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { LIMITS, modeError, sha256 } from "../contracts/index.js";
import type { ConfigRegistry, ConfigSource } from "../contracts/index.js";
import { findConfigPath } from "../core/config-file.js";
import { checkDirectory, imageJson, object, readImage, safeAbsolute } from "./fs.js";

export const registryRoot = (home: string): string => join(home, ".local/share/modeck/registry");
export const registryPath = (root: string): string => join(root, "registry.json");
export const sourceFor = (source: ConfigSource): ConfigSource & { readonly role: NonNullable<ConfigSource["role"]>; readonly namespace: string } =>
  Object.freeze({ ...source, role: source.role ?? "project",
    namespace: source.namespace ?? `config-${sha256(Buffer.from(source.root)).slice(0, 56)}` });

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
    if (Object.keys(project).some(key => !["root", "enabled", "role", "namespace"].includes(key)) || typeof project.root !== "string"
      || project.root.length > LIMITS.pathLength || typeof project.enabled !== "boolean"
      || !isAbsolute(project.root) || /\p{Cc}/u.test(project.root) || resolve(project.root) !== project.root
      || project.root === resolve(root)
      || project.role !== undefined && !["personal", "team", "project"].includes(String(project.role))
      || project.namespace !== undefined && (typeof project.namespace !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(project.namespace))) {
      throw modeError("E_CONFIG", "Invalid registered configuration project", { path });
    }
    return sourceFor(project as ConfigSource);
  });
  if (new Set(projects.map(project => project.root)).size !== projects.length) {
    throw modeError("E_CONFIG", "Duplicate registered configuration project", { path });
  }
  if (new Set(projects.map(project => project.namespace)).size !== projects.length) {
    throw modeError("E_CONFIG", "Duplicate configuration source namespace", { path });
  }
  return Object.freeze({ schemaVersion: 1, projects: Object.freeze(projects) });
};

export const configRoots = async (root: string): Promise<readonly string[]> => {
  const registry = await loadRegistry(root);
  return registry ? registry.projects.filter(project => project.enabled).map(project => project.root) : [root];
};
