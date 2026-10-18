import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonical, LIMITS, modeError } from "../contracts/index.js";
import type { FileImage } from "../contracts/index.js";
import { collectFacts, loadConfig, parseSelector, resolve } from "../core/index.js";
import { validateConfig } from "../core/config.js";
import { atomic, data, missing, parentIdentity, readImage, safeAbsolute, same } from "../integration/fs.js";
import { loadRegistry, registryPath } from "../integration/registry.js";
import { createUi, UiCancelled } from "./ui.js";

type Request = Readonly<{
  command: "eval" | "save"; configRoot: string; stateRoot: string; cwd: string; format: string; yes: boolean;
}>;
type Snapshot = Readonly<{ path: string; image: FileImage | null }>;
const snapshot = async (paths: readonly string[]): Promise<readonly Snapshot[]> =>
  Promise.all([...new Set(paths)].map(async path => ({ path, image: await readImage(path) })));
const unchanged = async (images: readonly Snapshot[]): Promise<void> => {
  await Promise.all(images.map(async ({ path, image }) => {
    if (!same(image, await readImage(path))) throw modeError("E_PLAN_STALE", "Selection input changed; evaluate again", { path });
  }));
};
const inputs = (root: string): readonly string[] => ["modeck.yaml", "modeck.yml", "modeck-auto.mjs"].map(name => join(root, name));
const unshadowed = async (cwd: string, boundary: string): Promise<void> => {
  if (cwd === boundary) return;
  const path = join(cwd, ".modes");
  const entry = await lstat(path).catch(error => { if (missing(error)) return null; throw error; });
  if (entry) throw modeError("E_SELECTOR", "A nearer .modes would override the saved repository selection; run save from the repository root", { path });
  await unshadowed(dirname(cwd), boundary);
};
export const evaluateModes = async ({ command, configRoot, stateRoot, cwd, format, yes }: Request): Promise<void> => {
  const root = await safeAbsolute(configRoot);
  const ui = createUi({ format: format === "json" ? "json" : "text" });
  // Snapshot discovery candidates too: adding an auto script or alternate YAML changes selection.
  const discovery = await snapshot([join(root, "modeck.yaml"), join(root, "modeck.yml")]);
  const registry = await loadRegistry(root);
  const registryImages = registry ? await snapshot([registryPath(root)]) : [];
  const roots = await Promise.all((registry ? registry.projects.filter(project => project.enabled).map(project => project.root) : [root]).map(safeAbsolute));
  if (roots.length > LIMITS.modes || new Set(roots).size !== roots.length) throw modeError("E_CONFIG", "Invalid configuration project selection");
  const candidates = await snapshot(roots.flatMap(inputs));
  const facts = await collectFacts({ cwd, stateRoot, ignoreSelector: true });
  const path = join(facts.boundary, ".modes");
  if (command === "save") await unshadowed(facts.cwd, facts.boundary);
  const parent = command === "save" ? await parentIdentity(path) : undefined;
  const before = command === "save" ? await readImage(path, LIMITS.jsonBytes) : null;
  const contexts = await Promise.all(roots.map(configRoot => loadConfig({ configRoot, facts })));
  const projects = contexts.map(context => {
    const plan = resolve({ context, facts, resourceDigest: "0".repeat(64) });
    return { configRoot: context.configRoot, configDigest: context.configDigest,
      sources: context.configSources ?? [], defaults: context.config.defaults,
      autoModeIds: context.autoModeIds ?? [], modeIds: plan.modeIds, reasons: plan.reasons,
      diagnostics: plan.diagnostics };
  });
  const modeIds = [...new Set(projects.flatMap(project => project.modeIds))];
  const diagnostics = modeIds.length ? [] : [{ code: "NO_MODES", message: "No modes selected by defaults or auto", path: null }];
  const result = { cwd: facts.cwd, boundary: facts.boundary, selectorPath: path, modeIds, projects, diagnostics };
  const verify = async (): Promise<void> => {
    await Promise.all(contexts.map(validateConfig));
    await unchanged([...discovery, ...registryImages, ...candidates]);
    if (canonical(await loadRegistry(root)) !== canonical(registry)) throw modeError("E_PLAN_STALE", "Configuration registry changed; evaluate again");
  };
  await verify();
  const report = (saved?: boolean): void => {
    if (format === "json") process.stdout.write(`${JSON.stringify({ ...result, ...(saved === undefined ? {} : { saved }) })}\n`);
    else {
      process.stdout.write(`Modes: ${modeIds.join(", ") || "(none)"}\n`);
      projects.forEach(project => {
        process.stdout.write(`Configuration: ${project.configRoot}\nDefaults: ${project.defaults.join(", ") || "(none)"}\nAuto: ${project.autoModeIds.join(", ") || "(none)"}\n`);
        project.sources.forEach(source => process.stdout.write(`Source: ${source.path}\n`));
        project.reasons.forEach(reason => process.stdout.write(`  ${reason.mode}: ${reason.via}${reason.from === null ? "" : ` (${reason.from})`}\n`));
        project.diagnostics.forEach(diagnostic => process.stdout.write(`${diagnostic.code}: ${diagnostic.message}\n`));
      });
      diagnostics.forEach(diagnostic => process.stdout.write(`${diagnostic.code}: ${diagnostic.message}\n`));
      if (saved !== undefined) process.stdout.write(saved ? `Saved: ${path}\n` : "No changes made.\n");
    }
  };
  if (command === "eval") { report(); return; }
  if (!modeIds.length) throw modeError("E_SELECTOR", "No modes selected; refusing to write an empty .modes that would enable auto");
  const content = `${modeIds.join("\n")}\n`;
  const selector = parseSelector(content);
  // Native selection filters shared IDs per configuration; replay that exact behavior before saving.
  contexts.forEach((context, index) => {
    const local = registry ? { ...selector, add: selector.add.filter(id => Object.hasOwn(context.config.modes, id)) } : selector;
    const replay = resolve({ context, facts: { ...facts, selector: { path, value: local } }, resourceDigest: "0".repeat(64) });
    if (canonical(replay.modeIds) !== canonical(projects[index]!.modeIds)) {
      throw modeError("E_SELECTOR", "A shared .modes cannot faithfully preserve automatic selection across configurations", { configRoot: context.configRoot });
    }
  });
  process.stderr.write(`${before ? "Overwrite" : "Create"} ${path}\nBefore: ${before ? JSON.stringify(data(before).toString("utf8")) : "(missing)"}\nAfter: ${JSON.stringify(content)}\n`);
  if (before && !yes) {
    if (format === "json") throw modeError("E_USAGE", "Overwriting .modes in JSON mode requires --yes");
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw modeError("E_USAGE", "Overwriting .modes requires a TTY confirmation or --yes");
    try { if (!await ui.confirm("Overwrite .modes?", false)) { report(false); return; } }
    catch (error) { if (error instanceof UiCancelled) { report(false); return; } throw error; }
  }
  await verify();
  if (!same(before, await readImage(path, LIMITS.jsonBytes))) throw modeError("E_PLAN_STALE", "Destination .modes changed; evaluate again", { path });
  await unshadowed(facts.cwd, facts.boundary);
  await atomic(path, { data: content, encoding: "utf8", mode: before?.mode ?? 0o644 }, parent);
  report(true);
};
