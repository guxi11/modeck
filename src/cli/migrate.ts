import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { LIMITS, modeError } from "../contracts/index.js";
import { collectFacts, loadConfig, parseManifest, resolve } from "../core/index.js";
import { validateConfig } from "../core/config.js";
import { findConfigPath, readConfigFile } from "../core/config-file.js";
import { exists, regularBytes, removeTemporary, requireValue, safePath, utf8, within } from "../resources/fs.js";
import { readResources } from "../resources/index.js";
import { scanProject } from "../resources/scan.js";
import { snapshotLocal, writeSnapshot } from "../resources/tree.js";
import { selections } from "./init.js";
import { backupSkills, planBackups } from "./backup.js";
import { addSkillBindings } from "./edit-config.js";

export const migrate = async (request: { readonly cwd: string; readonly configRoot: string; readonly stateRoot: string;
  readonly list: boolean; readonly answers?: string; readonly mode?: string }): Promise<unknown> => {
  const { cwd, configRoot, stateRoot } = request;
  requireValue(!within(configRoot, cwd), "E_PATH", "Run migrate from a business project outside the configuration repository");
  const facts = await collectFacts({ cwd, stateRoot });
  const context = await loadConfig({ configRoot, facts });
  const resolved = resolve({ context, facts, resourceDigest: "0".repeat(64) });
  const business = resolved.reasons.filter(reason => reason.via === "selector" || reason.via === "detect");
  const entryModes = [...new Set(business.map(reason => reason.mode))];
  const modes = request.mode ? [request.mode] : entryModes;
  if (request.mode) requireValue(Object.hasOwn(context.config.modes, request.mode), "E_USAGE", "Unknown destination mode", { mode: request.mode });
  const scan = await scanProject(cwd);
  if (request.list) return { ...scan, modes };
  requireValue(modes.length > 0, "E_USAGE", "No current mode; select a destination with --mode <name>");
  const choices = await selections(scan, request.answers, async selected => {
    const plan = await planBackups(scan, selected.map(choice => choice.id), configRoot);
    return `Bind to modes: ${modes.join(", ")}\nBackup destination: ${join(configRoot, ".modup", "backups")}/<batch>\n${plan.entries.map(item => `Back up: ${item.source}`).join("\n")}\n${plan.skipped.map(item => `Retain: ${item.path} (${item.reason})`).join("\n")}`;
  });
  if (!choices.length) return { configRoot, modes, resources: [], backupDirectory: null, backups: [], retained: [] };
  const backupPlan = await planBackups(scan, choices.map(choice => choice.id), configRoot);
  const names = choices.map(choice => choice.name);
  const paths = Object.fromEntries(names.map(name => [name, `skills/${name}`]));
  const configPath = await findConfigPath(configRoot);
  if (!configPath) throw modeError("E_CONFIG", "Configuration disappeared during migration");
  const original = (await regularBytes(configPath, LIMITS.jsonBytes)).bytes;
  const updated = addSkillBindings(utf8(original), paths, modes, configPath);
  const configMode = (await lstat(configPath)).mode & 0o777;
  const created: string[] = [];
  const staged = join(configRoot, ".modup", `migrate-${randomUUID()}${extname(configPath)}`);
  let installed = false;
  try {
    await choices.reduce(async (pending, choice) => {
      await pending;
      const resource = scan.resources.find(item => item.id === choice.id)!;
      const source = resource.sources[0]!;
      const destination = join(configRoot, paths[choice.name]!);
      const existing = context.config.resources[choice.name];
      requireValue(!existing || existing.kind === "skill" && existing.source.type === "local" && existing.source.path === paths[choice.name],
        "E_PATH", "Resource name is already mapped elsewhere; choose another name", { name: choice.name });
      const snapshot = await snapshotLocal(source, "skill");
      requireValue(snapshot.treeDigest === resource.treeDigest, "E_INTEGRITY", "Skill changed after discovery", { path: source });
      await safePath(destination, true);
      if (await exists(destination)) {
        requireValue((await snapshotLocal(destination, "skill")).treeDigest === snapshot.treeDigest, "E_PATH", "Skill name has different content; choose another name", { name: choice.name });
        return;
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      created.push(destination);
      await writeSnapshot(snapshot, destination, false);
      await chmod(destination, (await lstat(source)).mode & 0o777);
    }, Promise.resolve());
    await validateConfig(context);
    await safePath(dirname(staged), true);
    await mkdir(dirname(staged), { recursive: true, mode: 0o700 });
    await writeFile(staged, updated, { flag: "wx", mode: configMode });
    // Stage beside the original so all relative imports retain their meaning.
    const sibling = join(configRoot, `.modup-migrate-${randomUUID()}${extname(configPath)}`);
    try {
      await rename(staged, sibling);
      const { parseConfig } = await import("../core/index.js");
      parseConfig((await readConfigFile(sibling, facts)).config);
      await validateConfig(context);
      requireValue((await findConfigPath(configRoot)) === configPath, "E_PLAN_STALE", "Configuration path changed during migration");
      await rename(sibling, configPath);
      installed = true;
    } finally { await unlink(sibling).catch(() => undefined); }
    const imported = await loadConfig({ configRoot, facts });
    const destination = resolve({ context: imported, facts: { ...facts, selector: { path: join(cwd, ".modes"), value: { auto: false, add: modes } } }, resourceDigest: "0".repeat(64) });
    try {
      await readResources({ context: imported, stateRoot, parseManifest, resourceIds: destination.resources.map(item => item.id) });
    } catch (error) {
      if (error instanceof Error && error.message === "Skill names must be unique across all resources") {
        throw modeError("E_INTEGRITY", "SKILL.md.name conflicts in destination modes; change the name in the source SKILL.md before retrying (renaming the resource ID does not change metadata)", {
          modes, skills: choices.map(choice => {
            const resource = scan.resources.find(item => item.id === choice.id)!;
            return { resourceId: choice.name, name: resource.name, sources: resource.aliases.map(path => join(path, "SKILL.md")) };
          }),
        });
      }
      throw error;
    }
    const backups = await backupSkills(configRoot, backupPlan);
    return { configRoot, modes, resources: names, backupDirectory: backups.directory, backups: backups.entries, retained: backupPlan.skipped };
  } catch (error) {
    if (installed) {
      const current = await readFile(configPath);
      requireValue(current.equals(Buffer.from(updated)), "E_PATH", "Configuration changed during migration; inspect retained imports", { configPath });
      await writeFile(staged, original, { flag: "wx", mode: configMode });
      await rename(staged, configPath);
    }
    await [...created].reverse().reduce(async (pending, path) => { await pending; await removeTemporary(path); }, Promise.resolve());
    throw error;
  } finally { await unlink(staged).catch(() => undefined); }
};
