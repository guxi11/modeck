import { chmod, lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonical, checkRelativePath, LIMITS, modeError, sha256 } from "../contracts/index.js";
import type { Config, ResourceSpec } from "../contracts/index.js";
import { loadConfig, parseConfig } from "../core/index.js";
import { validateConfig } from "../core/config.js";
import { scanHome } from "../resources/index.js";
import type { ScannedResource } from "../resources/index.js";
import { compare, exists, regularBytes, requireValue, safePath, utf8, within } from "../resources/fs.js";
import { withConfigLock } from "../resources/lock.js";
import { snapshotLocal } from "../resources/tree.js";

type Request = { readonly home: string; readonly configRoot: string; readonly bindings?: unknown; readonly apply: boolean; readonly expect?: string };
type Desired = { readonly path: string; readonly kind: "file" | "directory"; readonly digest: string | null; readonly executable: boolean; readonly bytes?: Uint8Array };
const metadata = ["modup.config.mjs", "auto.mjs", "modes.json", "modes.lock.json", "modup.bindings.json", "modup-migration.json", ".modup-sync.lock",
  ".modup/.gitignore", ".modup/bindings.json", ".modup/migration.json", ".modup/verification.json", ".modup/legacy-lock.json"];
const auxiliaryIgnores = ["/bindings.json", "/migration.json", "/verification.json", "/legacy-lock.json"];
const digest = (value: unknown): string => sha256(Buffer.from(canonical(value)));
const jsonBytes = (value: unknown, limit: number): Buffer => {
  const bytes = Buffer.from(`${JSON.stringify(JSON.parse(canonical(value)) as unknown, null, 2)}\n`);
  requireValue(bytes.length <= limit, "E_LIMIT", "Migration JSON exceeds byte limit");
  return bytes;
};
const current = async (path: string): Promise<unknown> => {
  await safePath(path, true);
  if (!await exists(path)) return null;
  const info = await lstat(path);
  requireValue(info.isFile() || info.isDirectory(), "E_PATH", "Special migration destination rejected", { path });
  if (info.isDirectory()) return { kind: "directory" };
  const file = await regularBytes(path, LIMITS.fileBytes);
  return { kind: "file", digest: sha256(file.bytes), executable: file.executable };
};
const desiredImage = (item: Desired): unknown => item.kind === "directory" ? { kind: "directory" }
  : { kind: "file", digest: item.digest, executable: item.executable };

const execute = promisify(execFile);
const ignoredCopies = async (root: string, paths: readonly string[]) => {
  if (paths.length === 0) return { matches: [], policy: [] };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  // Honor the user's ignore configuration, but never invoke a filesystem monitor or hook.
  const operation = execute("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "check-ignore", "--stdin", "-z", "--verbose", "--non-matching"], {
    cwd: root, env, encoding: "buffer", timeout: LIMITS.probeTimeoutMs, maxBuffer: LIMITS.treeBytes,
  });
  operation.child.stdin?.end(Buffer.from(`${paths.join("\0")}\0`));
  const output = await operation.then(result => result.stdout).catch((error: unknown) => {
    if (error !== null && typeof error === "object" && "code" in error && error.code === 1 && "stdout" in error
      && Buffer.isBuffer(error.stdout)) return error.stdout;
    throw modeError("E_IO", "Cannot check migration resource Git ignore policy");
  });
  const fields = utf8(output).split("\0").slice(0, -1);
  requireValue(fields.length === paths.length * 4, "E_IO", "Incomplete Git ignore policy result");
  const matches = paths.map((path, index) => {
    const [source, line, pattern, actual] = fields.slice(index * 4, index * 4 + 4);
    requireValue(path === actual, "E_IO", "Unexpected Git ignore policy path");
    return { path, source: source!, line: line!, pattern: pattern!, ignored: Boolean(source) && !pattern!.startsWith("!") };
  });
  // Even a rule edit with no current matches invalidates a reviewed preview.
  const policies = [...new Set(paths.flatMap(path => [".gitignore", ...path.split("/").slice(0, -1)
    .map((_, index, parts) => [...parts.slice(0, index + 1), ".gitignore"].join("/"))]))].sort(compare);
  const policy = await Promise.all(policies.map(async path => ({ path,
    digest: await exists(join(root, path)) ? sha256((await regularBytes(join(root, path), LIMITS.jsonBytes)).bytes) : null })));
  return { matches, policy };
};

export const migrate = async (request: Request): Promise<unknown> => {
  const configRoot = await safePath(request.configRoot);
  requireValue((await lstat(configRoot)).isDirectory() && await exists(join(configRoot, ".git")),
    "E_PATH", "Migration requires an existing Git configuration repository");
  await safePath(join(configRoot, ".git"));
  const build = async () => {
    const scan = await scanHome(request.home);
    const executable = await exists(join(configRoot, "modup.config.mjs"));
    const configured = executable || await exists(join(configRoot, "modes.json"));
    const context = configured ? await loadConfig({ configRoot }) : null;
    const base = context?.config ?? parseConfig({ schemaVersion: 1, modes: {}, resources: {} });
    const bindingValue = request.bindings ?? { defaults: base.defaults, modes: base.modes };
    requireValue(bindingValue !== null && typeof bindingValue === "object" && !Array.isArray(bindingValue), "E_CONFIG", "bindings must be an object");
    const bindings = bindingValue as Record<string, unknown>;
    requireValue(Object.keys(bindings).every(key => ["defaults", "modes"].includes(key)), "E_CONFIG", "Unknown bindings field");
    // Conflict variants must be selected explicitly; other resources stay managed.
    const bindingModes = bindings.modes !== null && typeof bindings.modes === "object" && !Array.isArray(bindings.modes)
      ? Object.values(bindings.modes as Record<string, unknown>) : [];
    const mentioned = new Set(bindingModes.flatMap(value => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
      const mode = value as Record<string, unknown>;
      return [...(Array.isArray(mode.rules) ? mode.rules.filter(id => typeof id === "string") : []),
        ...(Array.isArray(mode.skills) ? mode.skills.flatMap(skill => skill !== null && typeof skill === "object"
          && "id" in skill && typeof skill.id === "string" ? [skill.id] : []) : [])];
    }));
    const selected = scan.conflicts.map(conflict => ({ ...conflict,
      chosen: conflict.ids.filter(id => mentioned.has(id)) }));
    const conflicts: { path: string; reason: string }[] = selected.filter(item => item.chosen.length !== 1)
      .map(item => ({ path: item.name, reason: `Select exactly one conflicting resource in bindings: ${item.ids.join(", ")}` }));
    const omitted = new Set(selected.flatMap(item => item.ids.filter(id => !item.chosen.includes(id))));
    const excluded = scan.resources.filter(item => omitted.has(item.id)).map(item => ({
      id: item.id, kind: item.kind, name: item.name, treeDigest: item.treeDigest,
      sources: item.sources, aliases: item.aliases, origins: item.origins,
      selectedIds: selected.find(conflict => conflict.ids.includes(item.id))!.chosen,
      reason: selected.some(conflict => conflict.ids.includes(item.id) && conflict.chosen.length === 1)
        ? "Conflicting variant excluded by explicit bindings; originals retained"
        : "Unresolved name conflict; explicit bindings selection required",
    }));
    const resources = scan.resources.filter(item => !omitted.has(item.id));
    const specs: Record<string, ResourceSpec> = { ...base.resources };
    const desired: Desired[] = [];
    const copies = new Set<string>();
    const tracked: { id: string; kind: string; treeDigest: string; path: string; sources: readonly string[]; aliases: readonly string[]; origins: ScannedResource["origins"] }[] = [];
    await resources.reduce(async (pending, item: ScannedResource) => {
      await pending;
      const local = item.sources.find(source => within(configRoot, source));
      const destination = local ? relative(configRoot, local).split("\\").join("/")
        : `.modup/resources/${item.kind}/${item.id}${item.kind === "rule" ? ".md" : ""}`;
      checkRelativePath(destination, false);
      requireValue(!metadata.some(path => path === destination || item.kind === "skill" && path.startsWith(`${destination}/`)),
        "E_PATH", "Resource overlaps migration metadata");
      const spec: ResourceSpec = { kind: item.kind, source: { type: "local", path: destination } };
      if (specs[item.id] && canonical(specs[item.id]) !== canonical(spec)) conflicts.push({ path: item.id, reason: "Existing resource descriptor differs" });
      else specs[item.id] = spec;
      const snapshot = await snapshotLocal(local ?? item.sources[0]!, item.kind);
      requireValue(snapshot.treeDigest === item.treeDigest, "E_PLAN_STALE", "Source changed while planning");
      if (!local || destination.startsWith(".modup/resources/")) {
        [...snapshot.files.keys()].forEach(path => copies.add(item.kind === "rule" ? destination : `${destination}/${path}`));
      }
      if (!local) {
        if (item.kind === "skill") {
          desired.push({ path: destination, kind: "directory", digest: null, executable: false });
          snapshot.entries.filter(entry => entry.kind === "directory").forEach(entry => desired.push({
            path: `${destination}/${entry.path}`, kind: "directory", digest: null, executable: false }));
        }
        [...snapshot.files.values()].forEach(file => desired.push({ path: item.kind === "rule" ? destination : `${destination}/${file.path}`,
          kind: "file", digest: sha256(file.bytes), executable: file.executable, bytes: file.bytes }));
      }
      // Validate the whole destination, so unexpected siblings cannot hide.
      if (await exists(join(configRoot, destination))) {
        const target = await snapshotLocal(join(configRoot, destination), item.kind);
        if (target.treeDigest !== item.treeDigest) conflicts.push({ path: destination, reason: "Existing destination tree differs" });
      }
      tracked.push({ id: item.id, kind: item.kind, treeDigest: item.treeDigest, path: destination, sources: item.sources, aliases: item.aliases, origins: item.origins });
    }, Promise.resolve());
    requireValue(resources.length + Object.keys(base.resources).filter(id => !resources.some(item => item.id === id)).length <= LIMITS.resources,
      "E_LIMIT", "Migration resource count exceeded");
    const config: Config = parseConfig({ schemaVersion: 1, defaults: bindings.defaults ?? [], modes: bindings.modes ?? {}, resources: specs });
    // Recheck previously copied resources even when the current scan no longer discovers their originals.
    await Object.values(config.resources).reduce(async (pending, spec) => {
      await pending;
      if (spec.source.type !== "local" || !spec.source.path.startsWith(".modup/resources/")
        || !await exists(join(configRoot, spec.source.path))) return;
      const snapshot = await snapshotLocal(join(configRoot, spec.source.path), spec.kind);
      [...snapshot.files.keys()].forEach(path => copies.add(spec.kind === "rule" ? spec.source.path : `${spec.source.path}/${path}`));
    }, Promise.resolve());
    const ignorePolicy = await ignoredCopies(configRoot, [...copies].sort(compare));
    ignorePolicy.matches.filter(match => match.ignored).forEach(match => conflicts.push({ path: match.path,
      reason: `Copied resource is Git-ignored by ${match.source}:${match.line} (${match.pattern}); sharing would omit it` }));
    const manifest = { schemaVersion: 1, owner: "modup/migration/1", resources: tracked, omitted: [...omitted].sort(compare), excluded };
    const configFile = executable || !configured ? "modup.config.mjs" : "modes.json";
    const configPath = join(configRoot, configFile);
    if (executable && canonical(base) !== canonical(config)) conflicts.push({ path: configFile,
      reason: "Update the trusted JavaScript configuration manually to include these resources/bindings; user code is never overwritten" });
    // Preserve existing user formatting if its normalized configuration matches.
    const configBytes = executable || configured && canonical(base) === canonical(config)
      ? (await regularBytes(configPath, LIMITS.jsonBytes)).bytes : configFile === "modes.json" ? jsonBytes(config, LIMITS.jsonBytes)
        : Buffer.from(`export default ${jsonBytes(config, LIMITS.jsonBytes).toString("utf8").trimEnd()};\n`);
    if (context) await validateConfig(context);
    const ignorePath = join(configRoot, ".modup/.gitignore");
    const ignoreBytes = await exists(ignorePath) ? (await regularBytes(ignorePath, LIMITS.jsonBytes)).bytes : null;
    const ignoreText = ignoreBytes === null ? "" : utf8(ignoreBytes);
    const missingIgnores = auxiliaryIgnores.filter(pattern => !ignoreText.split(/\r?\n/).includes(pattern));
    // Existing ignore policies are user-owned; additions are shown as a conflict instead of silently overwriting them.
    const desiredIgnores = missingIgnores.length === 0 && ignoreBytes !== null ? ignoreBytes
      : Buffer.from(`${ignoreText}${ignoreText && !ignoreText.endsWith("\n") ? "\n" : ""}${missingIgnores.join("\n")}\n`);
    [ { path: configFile, bytes: configBytes },
      { path: ".modup/migration.json", bytes: jsonBytes(manifest, LIMITS.lockBytes) },
      { path: ".modup/bindings.json", bytes: jsonBytes({ defaults: config.defaults, modes: config.modes }, LIMITS.jsonBytes) },
      { path: ".modup/.gitignore", bytes: desiredIgnores } ]
      .forEach(file => desired.push({ ...file, kind: "file", digest: sha256(file.bytes), executable: false }));
    const paths = [...new Set(desired.flatMap(item => {
      const parents = item.path.split("/").slice(0, -1);
      return parents.map((_, index) => parents.slice(0, index + 1).join("/"));
    }))];
    paths.filter(path => !desired.some(item => item.path === path)).forEach(path => desired.push({ path, kind: "directory", digest: null, executable: false }));
    desired.sort((a, b) => compare(a.path, b.path));
    requireValue(new Set(desired.map(item => item.path)).size === desired.length, "E_PATH", "Overlapping migration destinations");
    const targets = await Promise.all(desired.map(async item => {
      const before = await current(join(configRoot, item.path));
      if (before !== null && canonical(before) !== canonical(desiredImage(item))) conflicts.push({ path: item.path, reason: "Existing destination differs; overwrite forbidden" });
      return { path: item.path, before, after: desiredImage(item) };
    }));
    const publicPlan = { schemaVersion: 1, operation: "migrate", home: scan.home, configRoot, scanDigest: scan.scanDigest,
      resources: tracked, omitted: [...omitted].sort(compare), excluded, conflicts, changes: targets.filter(item => item.before === null), targets,
      configDigest: context?.configDigest ?? digest(config), manifestDigest: digest(manifest), ignorePolicy };
    return { plan: { ...publicPlan, planDigest: digest(publicPlan) }, desired };
  };
  const initial = await build();
  if (!request.apply) return initial.plan;
  requireValue(typeof request.expect === "string" && /^[0-9a-f]{64}$/.test(request.expect), "E_USAGE", "migrate --apply requires --expect DIGEST");
  requireValue(request.expect === initial.plan.planDigest, "E_PLAN_STALE", "Migration preview is stale");
  requireValue(initial.plan.conflicts.length === 0, "E_INSTALL_CONFLICT", "Migration has conflicts", { conflicts: initial.plan.conflicts });
  return withConfigLock(configRoot, async () => {
    const fresh = await build();
    requireValue(fresh.plan.planDigest === request.expect, "E_PLAN_STALE", "Migration sources or destinations changed");
    const created: { path: string; ino: number; dev: number; directory: boolean }[] = [];
    const completed = new Map<string, unknown>();
    try {
      await fresh.desired.reduce(async (pending, item) => {
        await pending;
        const path = join(configRoot, item.path);
        await safePath(path, true);
        if (await exists(path)) {
          requireValue(canonical(await current(path)) === canonical(desiredImage(item)), "E_PLAN_STALE", "Destination changed during apply", { path });
          return;
        }
        await safePath(dirname(path));
        if (item.kind === "directory") {
          await mkdir(path, { mode: 0o700 });
          const stat = await lstat(path);
          created.push({ path, ino: stat.ino, dev: stat.dev, directory: true });
        } else {
          const handle = await open(path, "wx", 0o600);
          try {
            const stat = await handle.stat();
            created.push({ path, ino: stat.ino, dev: stat.dev, directory: false });
            await handle.writeFile(item.bytes!);
            completed.set(path, { kind: "file", digest: item.digest, executable: false });
            await handle.chmod(item.executable ? 0o755 : item.path.endsWith(".json") ? 0o600 : 0o644);
            completed.set(path, desiredImage(item));
            await handle.sync();
          } finally { await handle.close(); }
        }
      }, Promise.resolve());
      const after = await build();
      const expectedPolicy = fresh.plan.ignorePolicy.policy.map(policy => ({ ...policy,
        digest: fresh.desired.find(item => item.path === policy.path && item.kind === "file")?.digest ?? policy.digest }));
      requireValue(after.plan.scanDigest === fresh.plan.scanDigest && after.plan.conflicts.length === 0 && after.plan.changes.length === 0,
        "E_PLAN_STALE", "Migration verification failed");
      requireValue(canonical(after.plan.ignorePolicy.policy) === canonical(expectedPolicy),
        "E_PLAN_STALE", "Git ignore policy changed during migration");
      await created.filter(item => item.directory).reduce(async (pending, item) => {
        await pending;
        await safePath(item.path);
        await chmod(item.path, 0o755);
      }, Promise.resolve());
      return { ...fresh.plan, applied: true };
    } catch (error) {
      // Only remove objects created by this transaction, never adopted files.
      const retained: string[] = [];
      await [...created].reverse().reduce(async (pending, item) => {
        await pending;
        try {
          await safePath(dirname(item.path));
          if (!await exists(item.path)) return;
          const stat = await lstat(item.path);
          const expected = completed.get(item.path);
          if (stat.ino !== item.ino || stat.dev !== item.dev || expected !== undefined
            && canonical(await current(item.path)) !== canonical(expected)) { retained.push(item.path); return; }
          if (item.directory) await rmdir(item.path);
          else await unlink(item.path);
        } catch { retained.push(item.path); }
      }, Promise.resolve());
      if (retained.length) throw modeError("E_IO", "Migration failed; rollback preserved changed or unremovable paths", {
        unrolledBackPaths: retained.sort(compare), cause: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
};
