import { lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { stringify } from "yaml";
import { LIMITS, modeError, sha256 } from "../contracts/index.js";
import type { Agent, ConfigContext, Kind } from "../contracts/index.js";
import { loadConfig, parseConfig, parseManifest, resolve } from "../core/index.js";
import { validateConfig } from "../core/config.js";
import { findConfigPath, readConfigFile } from "../core/config-file.js";
import { atomic, checkDirectory, readImage, same } from "../integration/fs.js";
import { loadRecord } from "../integration/install.js";
import { readResources } from "../resources/index.js";
import { exists, regularBytes, requireValue, safePath, utf8, within } from "../resources/fs.js";
import { scanCatalogReferences, scanHome } from "../resources/scan.js";
import type { ScannedResource } from "../resources/scan.js";
import { snapshotLocal } from "../resources/tree.js";
import { backupSkills, planBackups } from "./backup.js";
import { addResourceBindings } from "./edit-config.js";
import { choose, selections } from "./selection.js";

export type HomeMigrationOptions = {
  readonly list: boolean; readonly answers?: string; readonly agent?: Agent; readonly configRoot?: string;
};
const agents = ["claude", "codex", "codebuddy"] as const;
const resourcePath = (kind: Kind, name: string): string => kind === "rule" ? `rules/${name}.md` : `skills/${name}`;

const imported = async (resource: ScannedResource, context: ConfigContext | null, homeRoot: string): Promise<boolean> => {
  if (!context) return false;
  const matches = await Promise.all(Object.entries(context.config.resources).map(async ([id, spec]) => {
    if (spec.kind !== resource.kind || spec.source.type !== "local"
      || !context.config.defaults.length || !context.config.defaults.every(mode => {
        const entry = context.config.modes[mode]!;
        return (resource.kind === "rule" ? entry.rules : entry.skills).includes(id);
      })) return false;
    const paths = [join(context.configRoot, spec.source.path), join(homeRoot, resourcePath(spec.kind, id))];
    if (!(await Promise.all(paths.map(exists))).every(Boolean)) return false;
    return (await Promise.all(paths.map(path => snapshotLocal(path, spec.kind)))).every(snapshot => snapshot.treeDigest === resource.treeDigest);
  }));
  return matches.some(Boolean);
};

export const migrateHome = async (cwd: string, home: string, options: HomeMigrationOptions, initial = false): Promise<unknown> => {
  await safePath(home);
  await checkDirectory(home);
  const selectedAgents = options.agent ? [options.agent] : options.list ? agents
    : await choose("Scan · Select agents", agents.map(agent => ({ name: agent, value: agent })));
  if (!selectedAgents.length) return { resources: [], message: "No agents selected; no changes made." };
  const records = await Promise.all(selectedAgents.map(agent => loadRecord(home, agent)));
  const roots = [...new Set(records.flatMap(record => record ? [record.configRoot] : []))];
  requireValue(roots.length <= 1, "E_CONFIG", "Selected agents are bound to different repositories; scan them separately");
  requireValue(!options.configRoot || !roots[0] || options.configRoot === roots[0], "E_INSTALL_CONFLICT", "Explicit configuration differs from the selected agent binding");
  const root = await safePath(options.configRoot ?? roots[0] ?? cwd);
  await checkDirectory(root);
  requireValue((await lstat(root)).isDirectory(), "E_PATH", "Configuration root must be an existing directory");
  const homeRoot = join(home, ".modup");
  const existingConfigPath = await findConfigPath(root);
  const configPath = existingConfigPath ?? join(root, "modup.yaml");
  const autoPath = join(root, "modep-auto.mjs");
  const context = existingConfigPath ? await loadConfig({ configRoot: root }) : null;
  requireValue(initial || context, "E_CONFIG", "No configuration found; run init in the management repository first, or use --config");
  requireValue(context || !await exists(autoPath), "E_PATH", "modep-auto.mjs already exists without a modup configuration");
  const scan = await scanHome(home, selectedAgents);
  const referenceScan = await scanCatalogReferences(home);
  const pending = (await Promise.all(scan.resources.map(async resource => await imported(resource, context, homeRoot) ? [] : [resource]))).flat();
  const discovered = { ...scan, resources: pending };
  if (options.list) return { ...discovered, configRoot: root, homeRoot, agents: selectedAgents };
  if (!pending.length && (!initial || context)) {
    const message = "No new rules or skills found; no changes made.";
    process.stderr.write(`${message}\n`);
    return { configRoot: root, homeRoot, agents: selectedAgents, resources: [], message };
  }
  if (!options.answers) process.stderr.write(`\nResources · ${pending.filter(item => item.kind === "rule").length} rules · ${pending.filter(item => item.kind === "skill").length} skills\n`
    + `Configuration: ${root}\n${scan.excluded.length} excluded · ${scan.resources.length - pending.length} already imported\n\n`);
  const choices = !pending.length ? [] : await selections(discovered, options.answers, async selected => {
    const plan = await planBackups(scan, selected.map(choice => choice.id), root, true, referenceScan);
    return `Destinations (copied and verified first)\n  ${homeRoot}\n  ${root}\n\n`
      + `Back up ${plan.entries.length} native entries\n  ${join(root, ".modup", "backups")}/<batch>\n`
      + plan.entries.map(item => `  ${item.source}`).join("\n")
      + `\n\nRetain ${plan.skipped.length} managed/shared entries\n`
      + plan.skipped.map(item => `  ${item.path}\n    ${item.reason}`).join("\n");
  }, !initial);
  if (!choices.length && (pending.length || context)) return { configRoot: root, homeRoot, resources: [], message: "No resources selected; no changes made." };
  const backupPlan = await planBackups(scan, choices.map(choice => choice.id), root, true, referenceScan);
  const modes = context ? context.config.defaults : ["base"];
  requireValue(modes.length > 0, "E_CONFIG", "Configuration must define default modes before importing home resources");
  const resources = { rules: {} as Record<string, string>, skills: {} as Record<string, string> };
  const imports = await Promise.all(choices.map(async choice => {
    const resource = pending.find(item => item.id === choice.id)!;
    const path = resourcePath(resource.kind, choice.name);
    const existing = context?.config.resources[choice.name];
    requireValue(!existing || existing.kind === resource.kind && existing.source.type === "local" && existing.source.path === path,
      "E_PATH", "Resource ID is already mapped elsewhere; choose another name", { name: choice.name });
    const snapshot = await snapshotLocal(resource.sources[0]!, resource.kind);
    requireValue(snapshot.treeDigest === resource.treeDigest, "E_INTEGRITY", "Resource changed after discovery", { id: resource.id });
    const destinations = [...new Set([join(homeRoot, path), join(root, path)])];
    requireValue(resource.sources.every(source => destinations.every(destination => !within(source, destination) && !within(destination, source))),
      "E_PATH", "Migration source and destination overlap", { id: resource.id });
    resources[resource.kind === "rule" ? "rules" : "skills"][choice.name] = path;
    return { resource, snapshot, destinations };
  }));
  const original = await readImage(configPath, LIMITS.jsonBytes);
  requireValue(context || original === null, "E_PLAN_STALE", "Configuration appeared during migration");
  requireValue(!original || !utf8(Buffer.from(original.data, original.encoding === "base64" ? "base64" : "utf8")).includes("GENERATED by evoloop"),
    "E_INSTALL_CONFLICT", "evoloop owns the configuration; update its configuration source instead");
  const updated = context ? addResourceBindings(utf8((await regularBytes(configPath, LIMITS.jsonBytes)).bytes), resources, modes)
    : stringify({ resources, defaults: modes,
      modes: { base: { rules: Object.keys(resources.rules), skills: Object.keys(resources.skills) } } });
  const directories: { readonly path: string; readonly ino: number; readonly dev: number }[] = [];
  const files: { readonly path: string; readonly ino: number; readonly dev: number; readonly digest: string }[] = [];
  let installed = false;
  let interrupted = false;
  let preserve = false;
  const interrupt = () => { interrupted = true; };
  const check = () => { if (interrupted) throw modeError("E_USAGE", "Migration cancelled; original resources are retained"); };
  const directory = async (path: string): Promise<void> => {
    check(); await safePath(path, true);
    if (await exists(path)) { await checkDirectory(path); return; }
    await directory(dirname(path));
    await mkdir(path, { mode: 0o700 });
    const info = await lstat(path);
    directories.push({ path, ino: info.ino, dev: info.dev });
  };
  const write = async (path: string, bytes: Uint8Array, mode: number): Promise<void> => {
    check(); await directory(dirname(path));
    const handle = await open(path, "wx", mode);
    const info = await handle.stat();
    files.push({ path, ino: info.ino, dev: info.dev, digest: sha256(bytes) });
    try { await handle.writeFile(bytes); await handle.chmod(mode); } finally { await handle.close(); }
    check();
  };
  const verify = async (): Promise<void> => {
    await imports.reduce(async (previous, item) => {
      await previous; check();
      await Promise.all(item.destinations.map(async destination => {
        await checkDirectory(item.resource.kind === "rule" ? dirname(destination) : destination);
        requireValue((await snapshotLocal(destination, item.resource.kind)).treeDigest === item.snapshot.treeDigest,
          "E_INTEGRITY", "Destination changed before source removal", { path: destination });
      }));
    }, Promise.resolve());
  };
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let lockPath: string | undefined;
  process.on("SIGINT", interrupt);
  try {
    await directory(homeRoot);
    lockPath = join(homeRoot, "migration.lock");
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") throw modeError("E_BUSY", "Another home migration holds the lock", { path: lockPath });
      throw error;
    }
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    if (context) await validateConfig(context);
    await imports.reduce(async (previous, { resource, snapshot, destinations }) => {
      await previous;
      await destinations.reduce(async (pending, destination) => {
        await pending; check(); await safePath(destination, true);
        if (await exists(destination)) {
          requireValue((await snapshotLocal(destination, resource.kind)).treeDigest === snapshot.treeDigest,
            "E_PATH", "Resource destination has different content or executable permissions", { path: destination });
          return;
        }
        if (resource.kind === "rule") {
          const file = snapshot.files.get("content.md")!;
          await write(destination, file.bytes, file.executable ? 0o755 : 0o644);
        } else {
          await directory(destination);
          await snapshot.entries.reduce(async (pending, entry) => {
            await pending;
            const target = join(destination, entry.path);
            if (entry.kind === "directory") { await directory(target); return; }
            const file = snapshot.files.get(entry.path)!;
            await write(target, file.bytes, file.executable ? 0o755 : 0o644);
          }, Promise.resolve());
        }
      }, Promise.resolve());
    }, Promise.resolve());
    if (!context) await write(autoPath, Buffer.from("export default ({ cwd, boundary, files, dependencies }) => [];\n"), 0o644);
    const staged = join(root, `.modup-scan-${randomUUID()}${extname(configPath)}`);
    await write(staged, Buffer.from(updated), original?.mode ?? 0o644);
    parseConfig((await readConfigFile(staged)).config);
    check();
    if (context) await validateConfig(context);
    requireValue((await findConfigPath(root)) === existingConfigPath, "E_PLAN_STALE", "Configuration path changed during migration");
    requireValue(same(await readImage(configPath, LIMITS.jsonBytes), original), "E_PLAN_STALE", "Configuration changed during migration");
    await atomic(configPath, { data: updated, encoding: "utf8", mode: original?.mode ?? 0o644 });
    installed = true;
    const imported = await loadConfig({ configRoot: root });
    // Home imports target defaults, independently of project selectors and auto-detection.
    const selection = resolve({ context: imported, resourceDigest: "0".repeat(64), facts: {
      cwd: root, boundary: root, files: [], dependencies: [],
      selector: { path: join(root, ".modes"), value: { auto: false, add: [] } },
    } });
    await readResources({ context: imported, stateRoot: join(home, ".local/share/modup/v1"), parseManifest,
      resourceIds: selection.resources.map(resource => resource.id) });
    await verify();
    await validateConfig(imported);
    const currentRecords = await Promise.all(selectedAgents.map(agent => loadRecord(home, agent)));
    requireValue(JSON.stringify(currentRecords) === JSON.stringify(records), "E_PLAN_STALE", "Agent bindings changed during migration");
    requireValue((await scanHome(home, selectedAgents)).scanDigest === scan.scanDigest,
      "E_PLAN_STALE", "Native resources or ownership manifests changed during migration; scan again");
    const verifyReferences = async (): Promise<void> => {
      check();
      requireValue((await scanCatalogReferences(home)).referenceDigest === referenceScan.referenceDigest,
        "E_PLAN_STALE", "Cross-agent catalog references changed during migration; scan again");
      check();
    };
    await verifyReferences();
    const backups = await backupSkills(root, backupPlan, verifyReferences);
    // From here onward keep the verified copies even if reporting or cleanup fails.
    preserve = true;
    const stagedIdentity = files.find(file => file.path === staged)!;
    await (async () => {
      await safePath(staged);
      const info = await lstat(staged);
      if (info.ino === stagedIdentity.ino && info.dev === stagedIdentity.dev
        && sha256((await regularBytes(staged, LIMITS.jsonBytes)).bytes) === stagedIdentity.digest) await unlink(staged);
    })().catch(() => undefined);
    return { configRoot: root, homeRoot, agents: selectedAgents, resources: choices.map(choice => choice.name),
      backupDirectory: backups.directory, backups: backups.entries, retained: backupPlan.skipped };
  } catch (error) {
    if (installed && !preserve) {
      const current = await readImage(configPath, LIMITS.jsonBytes);
      if (same(current, { data: updated, encoding: "utf8", mode: original?.mode ?? 0o644 })) {
        await atomic(configPath, original);
      } else preserve = true;
    }
    if (!preserve) {
      await [...files].reverse().reduce(async (previous, file) => {
        await previous;
        try {
          await safePath(file.path);
          const info = await lstat(file.path);
          if (info.ino === file.ino && info.dev === file.dev
            && sha256((await regularBytes(file.path, LIMITS.fileBytes)).bytes) === file.digest) await unlink(file.path);
        } catch { /* Keep user edits and replaced files. */ }
      }, Promise.resolve());
    }
    throw error;
  } finally {
    if (lock && lockPath) {
      const identity = await lock.stat();
      await lock.close();
      await (async () => {
        await safePath(lockPath!);
        const current = await lstat(lockPath!);
        if (current.ino === identity.ino && current.dev === identity.dev) await unlink(lockPath!);
      })().catch(() => undefined);
    }
    if (!preserve) await [...directories].reverse().reduce(async (previous, item) => {
      await previous;
      try {
        await safePath(item.path);
        const info = await lstat(item.path);
        if (info.ino === item.ino && info.dev === item.dev) await rmdir(item.path);
      } catch { /* Keep nonempty or replaced directories. */ }
    }, Promise.resolve());
    process.off("SIGINT", interrupt);
  }
};
