import type * as TS from "typescript";
import { createRequire } from "node:module";
import { modeError } from "../contracts/index.js";

// Restrict edits to explicit object/array literals; executable expressions remain byte-for-byte intact.
export const addSkillBindings = (source: string, skills: Readonly<Record<string, string>>, modes: readonly string[]): string => {
  const ts: typeof TS = createRequire(import.meta.url)("typescript");
  const file = ts.createSourceFile("modup.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const unsupported = (): never => { throw modeError("E_CONFIG", "migrate needs a static export default object with explicit resources and mode skill arrays; edit modup.mjs before retrying"); };
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
    edits.push({ at: node.end - 1, text: `${items.length && !items.hasTrailingComma ? "," : ""}\n${values.join(",\n")}\n` });
  };
  const existingSkills = property(resources, "skills");
  if (existingSkills) {
    const map = object(existingSkills);
    append(map, Object.entries(skills).filter(([name]) => property(map, name) === undefined).map(([name, path]) => `${JSON.stringify(name)}: ${JSON.stringify(path)}`));
  } else append(resources, [`skills: ${JSON.stringify(skills)}`]);
  modes.forEach(id => {
    const mode = object(property(modeMap, id));
    const list = property(mode, "skills");
    if (!list) { append(mode, [`skills: ${JSON.stringify(Object.keys(skills))}`]); return; }
    if (!ts.isArrayLiteralExpression(list) || list.elements.some(item => !ts.isStringLiteral(item))) unsupported();
    const names = (list as TS.ArrayLiteralExpression).elements.map(item => (item as TS.StringLiteral).text);
    append(list as TS.ArrayLiteralExpression, Object.keys(skills).filter(name => !names.includes(name)).map(name => JSON.stringify(name)));
  });
  return edits.sort((a, b) => b.at - a.at).reduce((text, edit) => `${text.slice(0, edit.at)}${edit.text}${text.slice(edit.at)}`, source);
};
