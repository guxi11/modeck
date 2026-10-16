import type * as TS from "typescript";
import { createRequire } from "node:module";
import { extname } from "node:path";
import { isMap, isSeq, parseDocument, visit } from "yaml";
import { modeError } from "../contracts/index.js";
import { parseYamlConfig } from "../core/config-file.js";
import { parseConfig } from "../core/index.js";

type Bindings = Readonly<{ rules?: Readonly<Record<string, string>>; skills?: Readonly<Record<string, string>> }>;

const addYamlBindings = (source: string, bindings: Bindings, modes: readonly string[]): string => {
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

// Restrict edits to explicit object/array literals; executable expressions remain byte-for-byte intact.
export const addResourceBindings = (source: string,
  bindings: Bindings, modes: readonly string[], path = "modup.mjs"): string => {
  if ([".yaml", ".yml"].includes(extname(path))) return addYamlBindings(source, bindings, modes);
  const ts: typeof TS = createRequire(import.meta.url)("typescript");
  const file = ts.createSourceFile("modup.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const unsupported = (): never => { throw modeError("E_CONFIG", "Migration needs a static export default object with explicit resources and mode arrays; edit modup.mjs before retrying"); };
  const object = (node: TS.Node | undefined): TS.ObjectLiteralExpression => node && ts.isObjectLiteralExpression(node) ? node : unsupported();
  const propertyName = (node: TS.PropertyName): string => ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : unsupported();
  const property = (node: TS.ObjectLiteralExpression, name: string): TS.Expression | undefined => {
    const entries = node.properties.map(item => ts.isPropertyAssignment(item) ? [propertyName(item.name), item.initializer] as const : unsupported());
    if (new Set(entries.map(([key]) => key)).size !== entries.length) unsupported();
    return entries.find(([key]) => key === name)?.[1];
  };
  const exported = file.statements.filter(ts.isExportAssignment);
  if (exported.length !== 1 || exported[0]!.isExportEquals) unsupported();
  const root = object(exported[0]!.expression);
  const resources = object(property(root, "resources"));
  const modeMap = object(property(root, "modes"));
  const edits: { readonly at: number; readonly text: string }[] = [];
  const append = (node: TS.ObjectLiteralExpression | TS.ArrayLiteralExpression, values: readonly string[]): void => {
    if (!values.length) return;
    const items = ts.isObjectLiteralExpression(node) ? node.properties : node.elements;
    const previous = edits.find(edit => edit.at === node.end - 1);
    if (previous) {
      const index = edits.indexOf(previous);
      edits[index] = { at: previous.at, text: `${previous.text},\n${values.join(",\n")}\n` };
    } else edits.push({ at: node.end - 1, text: `${items.length && !items.hasTrailingComma ? "," : ""}\n${values.join(",\n")}\n` });
  };
  Object.entries(bindings).forEach(([group, entries]) => {
    const existing = property(resources, group);
    if (existing) {
      const map = object(existing);
      append(map, Object.entries(entries).filter(([name]) => property(map, name) === undefined)
        .map(([name, path]) => `${JSON.stringify(name)}: ${JSON.stringify(path)}`));
    } else append(resources, [`${group}: ${JSON.stringify(entries)}`]);
    modes.forEach(id => {
      const mode = object(property(modeMap, id));
      const list = property(mode, group);
      if (!list) { append(mode, [`${group}: ${JSON.stringify(Object.keys(entries))}`]); return; }
      if (!ts.isArrayLiteralExpression(list) || list.elements.some(item => !ts.isStringLiteral(item))) unsupported();
      const names = (list as TS.ArrayLiteralExpression).elements.map(item => (item as TS.StringLiteral).text);
      append(list as TS.ArrayLiteralExpression, Object.keys(entries).filter(name => !names.includes(name)).map(name => JSON.stringify(name)));
    });
  });
  return edits.sort((a, b) => b.at - a.at).reduce((text, edit) => `${text.slice(0, edit.at)}${edit.text}${text.slice(edit.at)}`, source);
};

export const addSkillBindings = (source: string, skills: Readonly<Record<string, string>>, modes: readonly string[], path = "modup.mjs"): string =>
  addResourceBindings(source, { skills }, modes, path);
