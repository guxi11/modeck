import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonical, LIMITS, modeError } from "../contracts/index.js";
import type { FileImage, Reason } from "../contracts/index.js";
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
const via = (reason: Reason, label: (id: string) => string): string =>
  reason.via === "parent" && reason.from !== null ? `via ${label(reason.from)}`
    : reason.via === "detect" ? "auto" : reason.via === "selector" ? ".modes" : reason.via;
// One line per selection: each mode followed by the distinct reasons that selected it.
export const describeModes = (modeIds: readonly string[], reasons: readonly Reason[], label: (id: string) => string = id => id): string =>
  modeIds.length ? modeIds.map(id => `${label(id)} (${[...new Set(reasons.filter(reason => reason.mode === id)
    .map(reason => via(reason, label)))].join(", ")})`).join(", ") : "(none)";
const diagnosticLine = ({ code, message, path }: { readonly code: string; readonly message: string; readonly path?: string | null }): string =>
  `${code}: ${message}${path ? ` (${path})` : ""}`;

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
  let selectorPath: string | null = null;
  let selectorAuto: boolean | null = null;
  let selectorAdds = false;
  let actualProjects: readonly { readonly configRoot: string; readonly modeIds: readonly string[] }[] | null = null;
  let actualDiagnostic: { readonly code: string; readonly message: string; readonly path: string | null } | null = null;
  if (command === "eval") {
    try {
      // Read the nearest .modes independently; automatic contexts above deliberately ignore it.
      const actualFacts = await collectFacts({ cwd, stateRoot });
      selectorPath = actualFacts.selector?.path ?? null;
      selectorAuto = actualFacts.selector?.value.auto ?? null;
      const added = actualFacts.selector?.value.add ?? [];
      selectorAdds = added.length > 0;
      const unknown = added.find(id => !contexts.some(context => Object.hasOwn(context.config.modes, id)));
      if (unknown !== undefined) {
        actualDiagnostic = { code: "E_SELECTOR", message: `Selector references unknown mode: ${unknown}`, path: selectorPath };
      } else {
        actualProjects = contexts.map(context => {
          const localFacts = registry && actualFacts.selector ? { ...actualFacts, selector: { ...actualFacts.selector,
            value: { ...actualFacts.selector.value, add: added.filter(id => Object.hasOwn(context.config.modes, id)) } } } : actualFacts;
          return { configRoot: context.configRoot,
            modeIds: resolve({ context, facts: localFacts, resourceDigest: "0".repeat(64) }).modeIds };
        });
      }
    } catch (error) {
      const details = error instanceof Error && "details" in error && error.details && typeof error.details === "object"
        ? error.details as Readonly<Record<string, unknown>> : {};
      const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "E_SELECTOR";
      const message = error instanceof Error && error.message ? error.message : "Could not read the current .modes selector";
      actualDiagnostic = { code, message, path: typeof details.path === "string" ? details.path : null };
      selectorPath = actualDiagnostic.path;
    }
  }
  const comparisons = actualProjects?.map(actual => {
    const computed = projects.find(project => project.configRoot === actual.configRoot)?.modeIds ?? [];
    const computedSet = new Set(computed);
    const actualSet = new Set(actual.modeIds);
    const actualOnly = actual.modeIds.filter(id => !computedSet.has(id));
    const computedOnly = computed.filter(id => !actualSet.has(id));
    const status = actualOnly.length || computedOnly.length ? "different"
      : actual.modeIds.some((id, index) => id !== computed[index]) ? "order-changed" : "same";
    return { configRoot: actual.configRoot, status, actualOnly, computedOnly };
  }) ?? null;
  const comparisonStatus = comparisons === null ? "unavailable"
    : comparisons.some(item => item.status === "different") ? "different"
      : comparisons.some(item => item.status === "order-changed") ? "order-changed" : "same";
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
    if (format === "json") process.stdout.write(`${JSON.stringify({ ...result,
      ...(command === "eval" ? { actual: { selectorPath, selectorAuto, projects: actualProjects, ...(actualDiagnostic ? { diagnostic: actualDiagnostic } : {}) },
        comparison: { status: comparisonStatus, projects: comparisons } } : {}),
      ...(saved === undefined ? {} : { saved }) })}\n`);
    else if (command === "eval") {
      const status = comparisonStatus === "same" ? "same" : comparisonStatus === "different" ? "different"
        : comparisonStatus === "order-changed" ? "order differs" : "unavailable";
      const tone = comparisonStatus === "same" ? "green" : comparisonStatus === "order-changed" ? "cyan" : "red";
      const effect = actualProjects === null ? "invalid" : selectorAuto === false ? "replaces auto"
        : selectorAdds ? "adds to auto" : "auto";
      const selector = selectorPath === null ? (actualProjects === null ? "unavailable" : "none (auto)") : `${selectorPath} (${effect})`;
      const lines = projects.flatMap(project => {
        const actual = actualProjects?.find(item => item.configRoot === project.configRoot);
        const comparison = comparisons?.find(item => item.configRoot === project.configRoot);
        return [`Config: ${project.configRoot}`, `  Computed: ${describeModes(project.modeIds, project.reasons)}`,
          `  Actual: ${actual ? actual.modeIds.join(", ") || "(none)" : "(unavailable)"}`,
          ...comparison?.status === "different" ? [
            ...comparison.actualOnly.length ? [`  Only in actual: ${comparison.actualOnly.join(", ")}`] : [],
            ...comparison.computedOnly.length ? [`  Only computed: ${comparison.computedOnly.join(", ")}`] : []] : [],
          ...project.diagnostics.map(diagnostic => `  ${diagnosticLine(diagnostic)}`)];
      });
      ui.section(`Evaluation: ${ui.emphasize(status, process.stdout, tone)}`, [`Selector: ${selector}`,
        ...lines.length ? lines : ["Config: (none)"],
        ...actualDiagnostic ? [`Actual selector: ${diagnosticLine(actualDiagnostic)}`] : [],
        ...diagnostics.map(diagnosticLine)].join("\n"));
    } else {
      ui.section(saved ? `Saved ${path}` : "No changes made", [...projects.flatMap(project => [`Config: ${project.configRoot}`,
        `  Modes: ${describeModes(project.modeIds, project.reasons)}`,
        ...project.diagnostics.map(diagnostic => `  ${diagnosticLine(diagnostic)}`)]),
      ...diagnostics.map(diagnosticLine)].join("\n"));
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
