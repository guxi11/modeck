import { join } from "node:path";
import { isMap, parseDocument } from "yaml";
import { LIMITS, modeError, sha256 } from "../contracts/index.js";
import { exists, regularBytes, utf8 } from "../resources/fs.js";

export const findConfigPath = async (root: string): Promise<string | undefined> => {
  const paths = (await Promise.all(["modeck.yaml", "modeck.yml"].map(async name => {
    const path = join(root, name);
    return await exists(path) ? [path] : [];
  }))).flat();
  if (paths.length > 1) throw modeError("E_CONFIG", "Multiple configuration files found; keep one modeck.yaml or modeck.yml", { paths });
  return paths[0];
};

export const parseYamlConfig = (source: string): unknown => {
  const document = parseDocument(source, { schema: "core", uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) {
    throw modeError("E_CONFIG", "Configuration must be a valid YAML mapping", {
      errors: [...document.errors, ...document.warnings].map(error => error.message),
    });
  }
  return document.toJS({ maxAliasCount: 100 });
};

export const readConfigFile = async (path: string): Promise<{ readonly config: unknown; readonly sources: readonly { readonly path: string; readonly digest: string }[] }> => {
  const { bytes } = await regularBytes(path, LIMITS.jsonBytes);
  return { config: parseYamlConfig(utf8(bytes)), sources: [{ path, digest: sha256(bytes) }] };
};
