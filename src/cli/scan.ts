import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { stringify } from "yaml";
import { agentDefinitions, agents, LIMITS, modeError, sha256 } from "../contracts/index.js";
import type { Agent, ConfigContext, Kind } from "../contracts/index.js";
import { loadConfig, parseConfig, parseManifest, resolve } from "../core/index.js";
import { validateConfig } from "../core/config.js";
import { findConfigPath, readConfigFile } from "../core/config-file.js";
import { atomic, checkDirectory, readImage, same } from "../integration/fs.js";
import { loadRecord } from "../integration/install.js";
import { readResources } from "../resources/index.js";
import { exists, missing, regularBytes, requireValue, safePath, utf8, within } from "../resources/fs.js";
import { scanCatalogReferences, scanHome } from "../resources/scan.js";
import type { ScannedResource } from "../resources/scan.js";
import { snapshotLocal } from "../resources/tree.js";
import { addResourceBindings } from "./edit-config.js";
import { choose, selections } from "./selection.js";
import { presentAgents } from "./bind.js";
import { projectRootFor } from "./config.js";

export type HomeMigrationOptions = {
  readonly list: boolean; readonly answers?: string; readonly agent?: Agent; readonly configRoot?: string;
};
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
    // A destination occupied by a symbolic link is not readable resource content;
    // treat it as not imported so the resource reaches the retained path instead of throwing.
    const plain = await Promise.all(paths.map(async path => {
      const info = await lstat(path).catch(error => { if (missing(error)) return null; throw error; });
      return info !== null && !info.isSymbolicLink();
    }));
    if (!plain.every(Boolean)) return false;
    return (await Promise.all(paths.map(path => snapshotLocal(path, spec.kind)))).every(snapshot => snapshot.treeDigest === resource.treeDigest);
  }));
  return matches.some(Boolean);
};

// A destination path already held by a symbolic link (dangling or not) is a user-owned
// reference; the resource is retained instead of migrated so the link is never clobbered.
const occupiedLink = async (resource: ScannedResource, roots: { readonly homeRoot: string; readonly root: string }): Promise<string | null> => {
  const destinations = [...new Set([join(roots.homeRoot, resourcePath(resource.kind, resource.id)), join(roots.root, resourcePath(resource.kind, resource.id))])];
  for (const destination of destinations) {
    const info = await lstat(destination).catch(error => { if (missing(error)) return null; throw error; });
    if (info?.isSymbolicLink()) return destination;
  }
  return null;
};

// Counts symbolic-link entries inside a catalog without following them; null when the tree
// is too deep to inspect. Links die by unlink only, never their targets.
const symlinkEntries = async (directory: string, depth: number): Promise<number | null> => {
  if (depth > LIMITS.scanDepth) return null;
  return (await readdir(directory)).reduce(async (counted, name) => {
    const count = await counted;
    if (count === null) return null;
    const info = await lstat(join(directory, name));
    if (info.isSymbolicLink()) return count + 1;
    if (!info.isDirectory()) return count;
    const nested = await symlinkEntries(join(directory, name), depth + 1);
    return nested === null ? null : count + nested;
  }, Promise.resolve(0 as number | null));
};

// Recursive removal that never follows symbolic links: every entry is typed with lstat
// before anything is removed, links are unlinked themselves, and directories are emptied
// bottom-up with rmdir so content behind a link is never touched.
const unlinkTree = async (path: string): Promise<void> => {
  const info = await lstat(path);
  if (!info.isDirectory()) { await unlink(path); return; }
  await (await readdir(path)).reduce(async (pending, name) => {
    await pending;
    await unlinkTree(join(path, name));
  }, Promise.resolve());
  await rmdir(path);
};

type SourceDirectory = {
  readonly dir: string;
  readonly removable: boolean;
  readonly reasons: readonly string[];
  readonly links: number;
  readonly extras: number;
};

export const migrateHome = async (cwd: string, home: string, options: HomeMigrationOptions, initial = false): Promise<unknown> => {
  await safePath(home);
  await checkDirectory(home);
  const selectedAgents = options.agent ? [options.agent] : options.list ? agents : await (async () => {
    const offered = await presentAgents(home);
    requireValue(offered.length > 0, "E_CONFIG", "No installed agents or existing bindings found; install an agent CLI before scanning");
    return choose("Scan · Select agents (installed on this machine)", offered.map(({ agent }) => ({ name: agent, value: agent })));
  })();
  if (!selectedAgents.length) return { resources: [], message: "No agents selected; no changes made." };
  const records = await Promise.all(selectedAgents.map(agent => loadRecord(home, agent)));
  const root = await safePath(initial ? options.configRoot ?? cwd : await projectRootFor(home, cwd, options.configRoot));
  await checkDirectory(root);
  requireValue((await lstat(root)).isDirectory(), "E_PATH", "Configuration root must be an existing directory");
  const homeRoot = join(home, ".modeck");
  const existingConfigPath = await findConfigPath(root);
  const configPath = existingConfigPath ?? join(root, "modeck.yaml");
  const autoPath = join(root, "modeck-auto.mjs");
  const context = existingConfigPath ? await loadConfig({ configRoot: root }) : null;
  requireValue(initial || context, "E_CONFIG", "No configuration found; run init in the management repository first, or use --config");
  requireValue(context || !await exists(autoPath), "E_PATH", "modeck-auto.mjs already exists without a modeck configuration");
  const scan = await scanHome(home, selectedAgents);
  const referenceScan = await scanCatalogReferences(home);
  const scanned = (await Promise.all(scan.resources.map(async resource => await imported(resource, context, homeRoot) ? [] : [resource]))).flat();
  const occupancies = await Promise.all(scanned.map(async resource => ({ resource, link: await occupiedLink(resource, { homeRoot, root }) })));
  // Destinations already held by a symbolic link are user-owned references: retained, never migrated.
  const retainedLinks = occupancies.filter(item => item.link !== null)
    .map(item => ({ id: item.resource.id, path: item.link!, reason: "Destination is an existing symbolic link; retained without migration" }));
  const pending = occupancies.filter(item => item.link === null).map(item => item.resource);
  const discovered = { ...scan, resources: pending };
  if (options.list) return { ...discovered, retained: retainedLinks, configRoot: root, homeRoot, agents: selectedAgents };
  if (!pending.length && (!initial || context)) {
    const message = "No new rules or skills found; no changes made.";
    return { configRoot: root, homeRoot, agents: selectedAgents, resources: [], retained: retainedLinks, message };
  }
  // Whole-directory removal is the point of the migration: afterwards the content lives in
  // the management repository. Candidates are the scanned agent skills catalogs themselves;
  // only hard safety gates apply (real, owned, unprotected, lexically equal to their real
  // path). Symbolic links and excluded entries inside no longer block removal — they are
  // counted, named in the question, and deleted with the directory, links by unlink only.
  const sourceDirectories = async (selectedIds: readonly string[]): Promise<readonly SourceDirectory[]> => {
    const selected = new Set(selectedIds);
    const pendingIds = new Set(pending.map(item => item.id));
    const protectedRoots = [root, homeRoot, join(root, ".modeck"), join(home, ".local/share/modeck/v1")];
    const catalogs = [...new Set(selectedAgents.flatMap(agent => agentDefinitions[agent].scanDirectories))]
      .map(dir => join(home, dir, "skills"));
    return (await Promise.all(catalogs.map(async (dir): Promise<SourceDirectory | null> => {
      const held = scan.resources.filter(resource => [...resource.sources, ...resource.aliases].some(path => within(dir, path)));
      if (!held.some(resource => selected.has(resource.id) && resource.kind === "skill")) return null;
      let links = 0;
      let extras = 0;
      const reasons: string[] = [];
      try {
        if (protectedRoots.some(path => within(path, dir) || within(dir, path)) || within(dir, home))
          reasons.push("inside or overlapping a protected modeck path or HOME");
        const info = await lstat(dir);
        if (info.isSymbolicLink()) reasons.push("directory is a symbolic link");
        else if (!info.isDirectory()) reasons.push("directory is not a real directory");
        if (info.uid !== process.getuid?.()) reasons.push("directory is not owned by the current user");
        if (await realpath(dir) !== dir) reasons.push("directory resolves across a symbolic link");
        const counted = await symlinkEntries(dir, 0);
        if (counted === null) reasons.push("directory is too deep to inspect");
        else links = counted;
        // Content that dies with the directory without being imported: excluded entries
        // that are not themselves links (links are counted above), and scanned resources
        // left unselected whose real content lives inside the directory.
        extras = (await Promise.all(scan.excluded.filter(item => within(dir, item.path)).map(async item => {
          const info = await lstat(item.path).catch(error => { if (missing(error)) return null; throw error; });
          return info !== null && !info.isSymbolicLink() ? 1 : 0;
        }))).reduce<number>((sum, value) => sum + value, 0)
          + held.filter(resource => !selected.has(resource.id) && pendingIds.has(resource.id)
            && resource.sources.some(source => within(dir, source))).length;
      } catch { reasons.push("directory cannot be inspected"); }
      return { dir, removable: reasons.length === 0, reasons, links, extras };
    }))).filter((item): item is SourceDirectory => item !== null);
  };
  // The end review names every scanned catalog: removable ones with what else dies with
  // them, refused ones with the exact gate that blocks them — never a silent skip.
  const describeSources = (sources: readonly SourceDirectory[]): string => {
    const removable = sources.filter(item => item.removable);
    const refused = sources.filter(item => !item.removable);
    const detail = (item: SourceDirectory): string => {
      const parts = [
        item.extras ? `${item.extras} unimported or excluded item${item.extras === 1 ? "" : "s"}` : "",
        item.links ? `${item.links} symbolic link${item.links === 1 ? "" : "s"} (links only; targets are kept)` : "",
      ].filter(Boolean);
      return parts.length ? `\n    also deletes ${parts.join(" and ")}` : "";
    };
    return (removable.length ? `\nRemove after verification (entire directories)\n`
      + removable.map(item => `  ${item.dir}${detail(item)}`).join("\n") + "\n" : "")
      + (refused.length ? `\nKeep ${refused.length} source director${refused.length === 1 ? "y" : "ies"} (removal refused)\n`
        + refused.map(item => `  ${item.dir}\n    ${item.reasons.join("; ")}`).join("\n") + "\n" : "");
  };
  if (!options.answers) process.stderr.write(`\nResources · ${pending.filter(item => item.kind === "rule").length} rules · ${pending.filter(item => item.kind === "skill").length} skills\n`
    + `Configuration: ${root}\n${scan.excluded.length} excluded · ${scan.resources.length - pending.length} already imported\n\n`);
  // Captured by the end confirm: whole-directory removal is offered whenever a scanned
  // catalog can be safely deleted, so consent is recorded before anything is written.
  let confirmedSources: readonly SourceDirectory[] = [];
  let removalOffered = false;
  const choices = !pending.length ? [] : await selections(discovered, options.answers, async selected => {
    const sources = await sourceDirectories(selected.map(choice => choice.id));
    return `Destinations (copied and verified first)\n  ${homeRoot}\n  ${root}\n`
      + (retainedLinks.length ? `\nRetain ${retainedLinks.length} entries whose destination is an existing link\n`
        + retainedLinks.map(item => `  ${item.path}\n    ${item.reason}`).join("\n") + "\n" : "")
      + describeSources(sources);
  }, {
    rename: false,
    confirm: async selected => {
      confirmedSources = await sourceDirectories(selected.map(choice => choice.id));
      const removable = confirmedSources.filter(item => item.removable);
      if (!removable.length) return "Import selected resources after verifying all destinations?";
      removalOffered = true;
      const extras = removable.reduce((sum, item) => sum + item.extras, 0);
      const links = removable.reduce((sum, item) => sum + item.links, 0);
      return extras || links
        ? `Remove the entire source directory after verifying all destinations? Also deletes ${extras} unimported or excluded item${extras === 1 ? "" : "s"} and ${links} symbolic link${links === 1 ? "" : "s"} (links only; targets are kept)`
        : "Remove the entire source directory after verifying all destinations?";
    },
  });
  if (!choices.length && (pending.length || context)) return { configRoot: root, homeRoot, resources: [], retained: retainedLinks, message: "No resources selected; no changes made." };
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
    // A source already at a destination is content living inside the catalog (typically an
    // agent catalog symlinked into the configuration root): the same-digest check downstream
    // accepts the existing copy and the native entry is retained. Strict containment either
    // way would copy or remove a tree inside itself and stays rejected.
    requireValue(resource.sources.every(source => destinations.every(destination =>
      source === destination || !within(source, destination) && !within(destination, source))),
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
    const staged = join(root, `.modeck-scan-${randomUUID()}${extname(configPath)}`);
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
      cwd: root, boundary: root, files: [], dependencies: [], excluded: [],
      selector: { path: join(root, ".modes"), value: { auto: false, add: [] } },
    } });
    await readResources({ context: imported, stateRoot: join(home, ".local/share/modeck/v1"), parseManifest,
      resourceIds: selection.resources.map(resource => resource.id) });
    await verify();
    await validateConfig(imported);
    const currentRecords = await Promise.all(selectedAgents.map(agent => loadRecord(home, agent)));
    requireValue(JSON.stringify(currentRecords) === JSON.stringify(records), "E_PLAN_STALE", "Agent bindings changed during migration");
    // Our own catalog writes are visible through symlinked agent catalogs, so the fresh scan
    // legitimately gains aliases for imported resources; drift is fatal only when it touches
    // anything other than the original resources (unchanged) and this migration's imports.
    const fresh = await scanHome(home, selectedAgents);
    const known = new Set(scan.resources.map(resource => resource.id));
    requireValue(scan.resources.every(resource => fresh.resources.some(item => item.id === resource.id && item.treeDigest === resource.treeDigest)),
      "E_PLAN_STALE", "Native resources or ownership manifests changed during migration; scan again");
    requireValue(fresh.resources.every(item => known.has(item.id)
      || imports.some(({ resource, snapshot }) => resource.id === item.id && snapshot.treeDigest === item.treeDigest)),
      "E_PLAN_STALE", "Native resources or ownership manifests changed during migration; scan again");
    const verifyReferences = async (): Promise<void> => {
      check();
      requireValue((await scanCatalogReferences(home)).referenceDigest === referenceScan.referenceDigest,
        "E_PLAN_STALE", "Cross-agent catalog references changed during migration; scan again");
      check();
    };
    await verifyReferences();
    // From here onward keep the verified copies even if reporting or cleanup fails.
    preserve = true;
    // Consent was captured by the end confirm: "No" cancels before anything runs. Every
    // directory is re-checked against the same hard gates, then deleted without ever
    // following symbolic links (links are unlinked themselves); refusals are reported,
    // never fatal.
    const removed: string[] = [];
    const consented = options.answers || !removalOffered ? [] : [...confirmedSources];
    await consented.reduce(async (pendingConsent, source) => {
      await pendingConsent; check();
      if (!source.removable) {
        process.stderr.write(`modeck: kept ${source.dir}: ${source.reasons.join("; ").replace(/\p{Cc}/gu, " ").trim()}\n`);
        return;
      }
      try {
        const info = await lstat(source.dir);
        requireValue(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.(),
          "E_PATH", "Source directory is not an owned real directory", { path: source.dir });
        requireValue(await realpath(source.dir) === source.dir, "E_PATH", "Source directory resolves across a symbolic link", { path: source.dir });
        await unlinkTree(source.dir);
        removed.push(source.dir);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(`modeck: refused to remove ${source.dir}: ${reason.replace(/\p{Cc}/gu, " ").trim()}\n`);
      }
    }, Promise.resolve());
    const stagedIdentity = files.find(file => file.path === staged)!;
    await (async () => {
      await safePath(staged);
      const info = await lstat(staged);
      if (info.ino === stagedIdentity.ino && info.dev === stagedIdentity.dev
        && sha256((await regularBytes(staged, LIMITS.jsonBytes)).bytes) === stagedIdentity.digest) await unlink(staged);
    })().catch(() => undefined);
    return { configRoot: root, homeRoot, agents: selectedAgents, resources: choices.map(choice => choice.name),
      retained: retainedLinks, removed };
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
