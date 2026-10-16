import { isMap, isSeq, parseDocument, visit } from "yaml";
import { modeError } from "../contracts/index.js";
import { parseYamlConfig } from "../core/config-file.js";
import { parseConfig } from "../core/index.js";

type Bindings = Readonly<{ rules?: Readonly<Record<string, string>>; skills?: Readonly<Record<string, string>> }>;

export const addResourceBindings = (source: string, bindings: Bindings, modes: readonly string[]): string => {
  parseConfig(parseYamlConfig(source));
  const document = parseDocument(source, { schema: "core", uniqueKeys: true, strict: true });
  // Editing an anchor would silently change modes that reference it.
  visit(document, { Alias: () => { throw modeError("E_CONFIG", "Expand YAML aliases before migrating resource bindings"); } });
  Object.entries(bindings).forEach(([group, entries]) => {
    const path = ["resources", group];
    if (!document.hasIn(path)) document.setIn(path, {});
    const resources = document.getIn(path, true);
    if (!isMap(resources)) throw modeError("E_CONFIG", "Migration needs explicit YAML resource mappings");
    Object.entries(entries).filter(([name]) => !resources.has(name)).forEach(([name, value]) => resources.set(name, value));
    modes.forEach(id => {
      const mode = document.getIn(["modes", id], true);
      if (!isMap(mode)) throw modeError("E_CONFIG", "Migration needs explicit YAML mode mappings", { mode: id });
      if (!mode.has(group)) mode.set(group, document.createNode([]));
      const list = mode.get(group, true);
      if (!isSeq(list)) throw modeError("E_CONFIG", "Migration needs explicit YAML mode arrays", { mode: id });
      const names: unknown[] = list.toJSON();
      Object.keys(entries).filter(name => !names.includes(name)).forEach(name => list.add(name));
    });
  });
  const updated = document.toString();
  parseConfig(parseYamlConfig(updated));
  return updated;
};

export const addSkillBindings = (source: string, skills: Readonly<Record<string, string>>, modes: readonly string[]): string =>
  addResourceBindings(source, { skills }, modes);
