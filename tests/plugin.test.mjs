import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import test from "node:test";
import { cliEnvironment, createPluginFixture, invokeModeck, invokeModeckArgs, invokeNative,
  invokeCodexAppServer, loadConfig, loadDynamicPluginResources, modeckBin, prepare, projectPlugin, readPluginBundles, repinPluginFixture } from "./plugin-fixture.mjs";

const nativeRows = output => {
  const value = JSON.parse(output);
  const rows = Array.isArray(value) ? value : value.plugins ?? value.installed ?? [];
  return rows.map(item => {
    const identity = typeof item.pluginId === "string" ? item.pluginId
      : typeof item.id === "string" ? item.id : undefined;
    const separator = identity?.lastIndexOf("@");
    const pluginId = item.pluginId && typeof item.pluginId === "object" ? item.pluginId : {};
    return {
      ...item,
      name: item.name ?? pluginId.name ?? (separator !== undefined && separator >= 0
        ? identity.slice(0, separator) : identity),
      marketplace: item.marketplace ?? item.marketplaceName ?? pluginId.marketplaceName
        ?? (separator !== undefined && separator >= 0 ? identity.slice(separator + 1) : undefined),
    };
  });
};
const statePath = (fixture, agent = "claude") => join(fixture.home, ".local", "share", "modeck", "plugins",
  createHash("sha256").update(fixture.config).digest("hex"), agent, "state.json");
const addClaudePlugin = async (fixture, { id, name, serverName }) => {
  const source = join(fixture.config, `${id}-source`);
  const { execFile: callback } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = promisify(callback);
  await execFile("git", ["clone", "--quiet", fixture.source, source]);
  const manifestPath = join(source, ".claude-plugin/plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.name = name;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const mcpPath = join(source, ".mcp.json");
  const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
  const server = Object.values(mcp.mcpServers)[0];
  mcp.mcpServers = { [serverName]: server };
  await writeFile(mcpPath, JSON.stringify(mcp));
  await execFile("git", ["-C", source, "add", "-A"]);
  await execFile("git", ["-C", source, "-c", "user.name=Modeck Test", "-c", "user.email=modeck@example.invalid",
    "commit", "--quiet", "-m", "second plugin fixture"]);
  const { stdout } = await execFile("git", ["-C", source, "rev-parse", "HEAD"]);
  const stanza = `  ${id}:\n    source:\n      url: ./${id}-source\n      commit: ${stdout.trim()}\n`;
  fixture.yaml = fixture.yaml.replace("resources: {}", `${stanza}resources: {}`);
  await writeFile(fixture.configFile, fixture.yaml);
};
const assertCodexPreflightRejectsWithoutTargetInstall = async (fixture, pattern, expectedCode = 2) => {
  await invokeModeck(fixture, "init", "codex");
  await assert.rejects(invokeModeck(fixture, "apply", "codex"), error => {
    assert.equal(error.code, expectedCode);
    assert.match(error.stderr, pattern);
    return true;
  });
  const rows = nativeRows((await invokeNative(fixture, "codex", ["plugin", "list", "--json"])).stdout);
  assert.equal(rows.some(plugin => plugin.name === "modeck-fixture" || plugin.pluginId === "modeck-fixture"), false,
    "a failed isolated loader check must leave the target Codex home untouched");
};

test("plugin CLI exposes its lifecycle and rejects duplicate or unknown options", async t => {
  const fixture = await createPluginFixture(t, { claudeOnly: true });
  const { execFile: callback } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = promisify(callback);
  const help = await execFile(process.execPath, [modeckBin, "plugin", "--help"], {
    cwd: fixture.cwd, env: cliEnvironment(fixture, "claude"), timeout: 30_000,
  });
  assert.match(help.stdout, /init\|status\|apply\|remove\|recover/u);
  await assert.rejects(execFile(process.execPath, [modeckBin, "plugin", "status", "--config", fixture.config,
    "--config", fixture.config, "--target-home", fixture.home, "--cwd", fixture.cwd, "--agent", "claude"], {
    cwd: fixture.cwd, env: cliEnvironment(fixture, "claude"), timeout: 30_000,
  }), error => error.code === 2 && /duplicate/u.test(error.stderr));
});

test("plugin mode selection activates all dynamic resources in the selected plugin", async t => {
  const fixture = await createPluginFixture(t);
  await invokeModeck(fixture, "init", "claude");
  const lock = await fixture.readLock();
  assert.equal(lock.version, 1);
  assert.equal(lock.plugins.length, 1);
  assert.equal(lock.plugins[0].commit, fixture.commit);
  assert.ok(lock.plugins[0].entries.some(entry => entry.path === "commands/check.md"));
  assert.ok(lock.plugins[0].entries.some(entry => entry.path === "assets/prompt.txt"));

  await writeFile(join(fixture.cwd, ".modes"), "selected\n");
  const resolvedText = await invokeModeckArgs(fixture, ["resolve", "--config", fixture.config, "--state", fixture.state,
    "--cwd", fixture.cwd, "--format", "text"]);
  assert.match(resolvedText.stdout, /Selected plugins · 1/u);
  assert.match(resolvedText.stdout, /fixture/u);
  const resolvedJson = await invokeModeckArgs(fixture, ["resolve", "--config", fixture.config, "--state", fixture.state,
    "--cwd", fixture.cwd, "--format", "json"]);
  assert.deepEqual(JSON.parse(resolvedJson.stdout).pluginIds, ["fixture"]);
  const selected = await invokeModeckArgs(fixture, ["render", "--config", fixture.config, "--state", fixture.state,
    "--cwd", fixture.cwd, "--agent", "claude", "--format", "json"]);
  const selectedText = JSON.parse(selected.stdout).text;
  assert.match(selectedText, /Selected fixture rule/);
  assert.match(selectedText, /Plugin guide skill/u);
  assert.match(selectedText, /Plugin reference skill/u);
  const guideRecord = JSON.parse(selectedText.split("\n").find(line => line.startsWith('{"description":"Plugin guide skill",')));
  const selectedSkill = await readFile(guideRecord.entry, "utf8");
  const lockedRoot = join(fixture.config, "vendor", "plugins", "fixture", (await fixture.readLock()).plugins[0].treeDigest);
  assert.ok(selectedSkill.includes(`${lockedRoot}/assets/prompt.txt`));
  const supportPaths = /^Run (\S+\/scripts\/support\.sh) and (\S+\/scripts\/support\.sh)\.$/mu.exec(selectedSkill);
  assert.ok(supportPaths, "indexed SKILL entry must expose both resolved support script paths");
  assert.equal(supportPaths[1], `${lockedRoot}/scripts/support.sh`);
  assert.equal(supportPaths[2], `${lockedRoot}/scripts/support.sh`);
  assert.doesNotMatch(selectedSkill, /\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/u);
  assert.equal(await readFile(supportPaths[1], "utf8"), "#!/bin/sh\nprintf 'fixture support script\\n'\n");
  const originalSkill = await readFile(join(fixture.source, "skills/guide/SKILL.md"), "utf8");
  assert.match(originalSkill, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/support\.sh/u);
  assert.match(originalSkill, /\$\{PLUGIN_ROOT\}\/scripts\/support\.sh/u);
  const verified = await loadDynamicPluginResources(fixture);
  const verifiedGuide = verified.resources.resources.find(resource => resource.skill?.name === "modeck-fixture-guide");
  assert.ok(verifiedGuide?.root, "the transformed plugin skill must be published as a verified resource");
  const storedSkill = await readFile(join(verifiedGuide.root, "SKILL.md"), "utf8");
  assert.ok(storedSkill.includes(`${lockedRoot}/assets/prompt.txt`));
  const storedSupportPaths = /^Run (\S+\/scripts\/support\.sh) and (\S+\/scripts\/support\.sh)\.$/mu.exec(storedSkill);
  assert.ok(storedSupportPaths, "stored verified SKILL.md must contain resolved support paths");
  assert.equal(storedSupportPaths[1], `${lockedRoot}/scripts/support.sh`);
  assert.equal(storedSupportPaths[2], `${lockedRoot}/scripts/support.sh`);
  assert.equal(await readFile(storedSupportPaths[1], "utf8"), await readFile(join(fixture.source, "scripts/support.sh"), "utf8"));
  assert.deepEqual(await readFile(join(verifiedGuide.root, "assets/payload.bin")),
    await readFile(join(fixture.source, "skills/guide/assets/payload.bin")));

  await writeFile(join(fixture.cwd, ".modes"), "base\n");
  const base = await invokeModeckArgs(fixture, ["render", "--config", fixture.config, "--state", fixture.state,
    "--cwd", fixture.cwd, "--agent", "claude", "--format", "json"]);
  assert.doesNotMatch(JSON.parse(base.stdout).text, /Selected fixture rule|name.:.guide|name.:.reference/u);
});

test("dynamic plugin content explicitly rejects unavailable PLUGIN_DATA and user_config values", async t => {
  for (const token of ["${PLUGIN_DATA}/settings.json", "${user_config.apiKey}"]) await t.test(token, async t => {
    const fixture = await createPluginFixture(t);
    const skill = join(fixture.source, "skills/guide/SKILL.md");
    const contents = (await readFile(skill, "utf8")).replace("Plugin guide content.", `Plugin guide content ${token}.`);
    await writeFile(skill, contents);
    await repinPluginFixture(fixture);
    await invokeModeck(fixture, "init", "claude");
    await writeFile(join(fixture.cwd, ".modes"), "selected\n");
    await assert.rejects(invokeModeckArgs(fixture, ["render", "--config", fixture.config, "--state", fixture.state,
      "--cwd", fixture.cwd, "--agent", "claude", "--format", "json"]), error => {
      assert.equal(error.code, 3);
      assert.match(error.stderr, /requires unavailable plugin data or user configuration/u);
      return true;
    });
  });
});

test("static Claude projection removes dynamic scan roots while retaining native components", async t => {
  const fixture = await createPluginFixture(t);
  await invokeModeck(fixture, "init", "claude");
  const context = await loadConfig({ configRoot: fixture.config });
  const [bundle] = await readPluginBundles(context);
  const projected = await projectPlugin(bundle, "claude", join(fixture.root, "projection"));
  await assert.rejects(readFile(join(projected.root, "skills/guide/SKILL.md")), { code: "ENOENT" });
  await assert.rejects(readFile(join(projected.root, "skills/reference/SKILL.md")), { code: "ENOENT" });
  await assert.rejects(readFile(join(projected.root, "rules/policy.md")), { code: "ENOENT" });
  assert.match(await readFile(join(projected.root, "commands/check.md"), "utf8"), /Native command/);
  assert.match(await readFile(join(projected.root, "commands/SKILL.md"), "utf8"), /Retain this as a native command/u);
  assert.match(await readFile(join(projected.root, "agents/reviewer.md"), "utf8"), /name: reviewer[\s\S]*description:/u);
  const hooks = JSON.parse(await readFile(join(projected.root, "hooks/hooks.json"), "utf8"));
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].type, "command");
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /write-marker\.mjs/u);
  const lsp = JSON.parse(await readFile(join(projected.root, ".lsp.json"), "utf8"));
  assert.equal(lsp["fixture-lsp"].command, "node");
  assert.deepEqual(lsp["fixture-lsp"].extensionToLanguage, { ".fixture": "modeck-fixture" });
  const claudeMcp = JSON.parse(await readFile(join(projected.root, ".mcp.json"), "utf8"));
  assert.equal(claudeMcp.mcpServers["fixture-api"].args[0], "${CLAUDE_PLUGIN_ROOT}/server.mjs");
  assert.equal(claudeMcp.mcpServers["fixture-api"].env.TOKEN, "${PLUGIN_TEST_TOKEN}");
  assert.match(await readFile(join(projected.root, "assets/prompt.txt"), "utf8"), /support asset/);
  const manifest = JSON.parse(await readFile(join(projected.root, ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.skills, undefined);
  assert.ok(projected.components.includes("commands"));
  const validation = await invokeNative(fixture, "claude", ["plugin", "validate", projected.root, "--json"]);
  const validationResult = JSON.parse(validation.stdout);
  assert.equal(validationResult.success, true);
  assert.deepEqual(validationResult.manifest.errors, []);
  assert.deepEqual(validationResult.manifest.warnings, []);
});

test("plugin lifecycle never silently accepts a missing pin", async t => {
  const fixture = await createPluginFixture(t);
  await writeFile(fixture.configFile, fixture.yaml.replace(fixture.commit, "main"));
  const { execFile: callback } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = promisify(callback);
  await assert.rejects(execFile(process.execPath, [modeckBin, "plugin", "init", "--config", fixture.config,
    "--target-home", fixture.home, "--cwd", fixture.cwd, "--agent", "claude"],
  { cwd: fixture.cwd, env: cliEnvironment(fixture, "claude"), timeout: 30_000 }));
});

test("status is read-only and does not create an ownership journal", async t => {
  const fixture = await createPluginFixture(t);
  await invokeModeck(fixture, "init", "claude");
  await invokeModeck(fixture, "status", "claude");
  await assert.rejects(access(join(fixture.home, ".local/share/modeck/plugins")), { code: "ENOENT" });
});

test("a locked bundle integrity mismatch blocks status after local tampering", async t => {
  const fixture = await createPluginFixture(t);
  await invokeModeck(fixture, "init", "claude");
  const lock = await fixture.readLock();
  const root = join(fixture.config, "vendor", "plugins", lock.plugins[0].id, lock.plugins[0].treeDigest);
  const asset = join(root, "assets/prompt.txt");
  await chmod(asset, 0o600);
  await writeFile(asset, "changed after lock\n");
  await assert.rejects(invokeModeck(fixture, "status", "claude"), /integrity|locked|tree/iu);
});

test("plugin source paths cannot escape and Git symlinks are rejected", async t => {
  const fixture = await createPluginFixture(t);
  await writeFile(fixture.configFile, fixture.yaml.replace(`commit: ${fixture.commit}`, `commit: ${fixture.commit}\n      path: ../outside`));
  await assert.rejects(invokeModeck(fixture, "init", "claude"), /path|escape|relative/iu);

  const { symlink: makeSymlink } = await import("node:fs/promises");
  const { execFile: callback } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = promisify(callback);
  await writeFile(fixture.configFile, fixture.yaml);
  await makeSymlink(fixture.cwd, join(fixture.source, "linked-project"));
  await execFile("git", ["-C", fixture.source, "add", "linked-project"]);
  await execFile("git", ["-C", fixture.source, "-c", "user.name=Modeck Test", "-c", "user.email=modeck@example.invalid", "commit", "--quiet", "-m", "symlink fixture"]);
  const { stdout: commit } = await execFile("git", ["-C", fixture.source, "rev-parse", "HEAD"]);
  await writeFile(fixture.configFile, fixture.yaml.replace(fixture.commit, commit.trim()));
  await assert.rejects(invokeModeck(fixture, "init", "claude"), /symlink|link|special/iu);
});

test("registered configs deduplicate identical dynamic skills and reject different same-name content", async t => {
  const first = await createPluginFixture(t);
  const second = await createPluginFixture(t);
  await invokeModeck(first, "init", "claude");
  await invokeModeck(second, "init", "claude");
  await writeFile(join(first.cwd, ".modes"), "selected\n");
  const request = { agent: "claude", configRoot: first.config, configRoots: [first.config, second.config],
    stateRoot: first.state, cwd: first.cwd };
  const combined = await prepare(request);
  assert.equal(combined.rendered.text.split('"name":"modeck-fixture-guide"').length - 1, 1);
  assert.equal(combined.rendered.text.split('"name":"modeck-fixture-reference"').length - 1, 1);

  const skill = join(second.source, "skills/guide/SKILL.md");
  await writeFile(skill, "---\nname: guide\ndescription: Plugin guide skill\n---\nDifferent content at another pin.\n");
  await repinPluginFixture(second);
  await invokeModeck(second, "init", "claude");
  await assert.rejects(prepare(request), /same skill name|different content/iu);
});

test("Claude native inventory is verified and removal refuses projection drift", async t => {
  const fixture = await createPluginFixture(t, { claudeOnly: true });
  await invokeModeck(fixture, "init", "claude");
  const applied = JSON.parse((await invokeModeck(fixture, "apply", "claude")).stdout);
  assert.equal(applied.outcome, "applied");
  assert.match(applied.trust, /trust prompts remain under agent control/u);
  assert.equal(JSON.parse((await invokeModeck(fixture, "status", "claude")).stdout).plugins[0].installed, true);
  const listed = await invokeNative(fixture, "claude", ["plugin", "list", "--json"]);
  assert.match(listed.stdout, /modeck-fixture/);
  const installed = nativeRows(listed.stdout).find(item => item.name === "modeck-fixture" || item.id?.startsWith("modeck-fixture@"));
  assert.ok(installed, listed.stdout);
  const details = await invokeNative(fixture, "claude", ["plugin", "details", installed.id ?? `${installed.name}@${installed.marketplaceName}`]);
  assert.match(details.stdout, /check|commands/iu);
  assert.match(details.stdout, /reviewer|agents/iu);
  assert.match(details.stdout, /SessionStart|hooks/iu);
  assert.match(details.stdout, /fixture-lsp|LSP/iu);
  assert.match(details.stdout, /fixture-api|MCP/iu);
  const managedCommand = join(installed.readFromFolder, "commands/check.md");
  const originalCommand = await readFile(managedCommand, "utf8");
  await writeFile(managedCommand, `${originalCommand}\nlocal drift\n`);
  await assert.rejects(invokeModeck(fixture, "remove", "claude"), error => {
    assert.equal(error.code, 4);
    assert.match(error.stderr, /projection contents or integrity marker drifted/u);
    return true;
  });
  const journalPath = statePath(fixture);
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.stage = "removing";
  await writeFile(journalPath, JSON.stringify(journal));
  await assert.rejects(invokeModeck(fixture, "recover", "claude"), error => {
    assert.equal(error.code, 4);
    assert.match(error.stderr, /projection contents or integrity marker drifted/u);
    return true;
  });
  journal.stage = "plugin-added";
  await writeFile(journalPath, JSON.stringify(journal));
  assert.ok(nativeRows((await invokeNative(fixture, "claude", ["plugin", "list", "--json"])).stdout)
    .some(item => item.id === installed.id));
  await writeFile(managedCommand, originalCommand);
  const removed = JSON.parse((await invokeModeck(fixture, "remove", "claude")).stdout);
  assert.equal(removed.outcome, "removed");
  assert.doesNotMatch((await invokeNative(fixture, "claude", ["plugin", "list", "--json"])).stdout, /modeck-fixture/u);
});

test("Claude native apply preserves sanitized CLI diagnostic output on failure", async t => {
  const fixture = await createPluginFixture(t, { claudeOnly: true });
  await invokeModeck(fixture, "init", "claude");
  const shim = join(fixture.root, "shim");
  await mkdir(shim);
  const { execFile: callback } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = promisify(callback);
  const { stdout: claudeBin } = await execFile("which", ["claude"]);
  await writeFile(join(shim, "claude"), `#!/bin/sh\nif [ "$1" = plugin ] && [ "$2" = install ]; then\n  printf 'native install diagnostic target=%s api_key=%s\\n' "$HOME" 'fixture-secret'\n  exit 42\nfi\nexec ${claudeBin.trim()} "$@"\n`);
  await chmod(join(shim, "claude"), 0o700);
  fixture.nativePath = shim;
  await assert.rejects(invokeModeck(fixture, "apply", "claude"), error => {
    assert.equal(error.code, 3);
    assert.match(error.stderr, /claude plugin install .* failed/u);
    assert.match(error.stderr, /native install diagnostic/u);
    assert.doesNotMatch(error.stderr, /fixture-secret|modeck-plugin-test/u);
    return true;
  });
  fixture.nativePath = undefined;
  const recovered = JSON.parse((await invokeModeck(fixture, "recover", "claude")).stdout);
  assert.equal(recovered.outcome, "recovered");
});

test("apply refuses to take over a same-name plugin installed from an unmanaged marketplace", async t => {
  const fixture = await createPluginFixture(t, { claudeOnly: true });
  await invokeModeck(fixture, "init", "claude");
  const marketplace = join(fixture.root, "unmanaged-marketplace");
  const plugin = join(marketplace, "plugins", "fixture");
  await mkdir(join(marketplace, ".claude-plugin"), { recursive: true });
  await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
  await writeFile(join(marketplace, ".claude-plugin/marketplace.json"), JSON.stringify({
    name: "unmanaged-fixture", owner: { name: "test" },
    plugins: [{ name: "modeck-fixture", source: "./plugins/fixture" }],
  }));
  await writeFile(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "modeck-fixture", version: "1.0.0" }));
  await invokeNative(fixture, "claude", ["plugin", "marketplace", "add", marketplace, "--scope", "user", "--json"]);
  await invokeNative(fixture, "claude", ["plugin", "install", "modeck-fixture@unmanaged-fixture",
    "--scope", "user", "--json", "-y"]);
  await assert.rejects(invokeModeck(fixture, "apply", "claude"), error => {
    assert.equal(error.code, 4);
    assert.match(error.stderr, /conflicts with another marketplace/u);
    return true;
  });
  const installed = nativeRows((await invokeNative(fixture, "claude", ["plugin", "list", "--json"])).stdout);
  assert.ok(installed.some(item => item.id === "modeck-fixture@unmanaged-fixture"));
  await invokeNative(fixture, "claude", ["plugin", "uninstall", "modeck-fixture@unmanaged-fixture",
    "--keep-data", "--scope", "user", "--json", "-y"]);
  await invokeNative(fixture, "claude", ["plugin", "marketplace", "remove", "unmanaged-fixture"]);
  const retried = JSON.parse((await invokeModeck(fixture, "apply", "claude")).stdout);
  assert.equal(retried.outcome, "applied", "a failed preflight must not strand an unowned generation that blocks retry");
  assert.equal(JSON.parse((await invokeModeck(fixture, "remove", "claude")).stdout).outcome, "removed");
});

test("apply does not claim an existing same-marketplace install without a journal fingerprint", async t => {
  const fixture = await createPluginFixture(t, { claudeOnly: true });
  await invokeModeck(fixture, "init", "claude");
  const shim = join(fixture.root, "shim");
  await mkdir(shim);
  const { execFileSync } = await import("node:child_process");
  const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  const marketplace = `modeck-${createHash("sha256").update(fixture.config + String.fromCharCode(0) + "claude").digest("hex").slice(0, 16)}`;
  const pluginId = `modeck-fixture@${marketplace}`;
  const script = [
    "#!/bin/sh",
    'if [ "$1" = plugin ] && [ "$2" = marketplace ] && [ "$3" = add ]; then',
    `  "${claudeBin}" "$@" || exit $?`,
    `  "${claudeBin}" plugin install "${pluginId}" --scope user --json || exit $?`,
    "  exit 0",
    "fi",
    `exec "${claudeBin}" "$@"`,
    "",
  ].join("\n");
  await writeFile(join(shim, "claude"), script);
  await chmod(join(shim, "claude"), 0o700);
  fixture.nativePath = shim;
  await assert.rejects(invokeModeck(fixture, "apply", "claude"), error => {
    assert.equal(error.code, 4);
    assert.match(error.stderr, /already installed|ownership requires/u);
    return true;
  });
  fixture.nativePath = undefined;
  const installed = nativeRows((await invokeNative(fixture, "claude", ["plugin", "list", "--json"])).stdout);
  assert.ok(installed.some(item => item.id === pluginId), "the preexisting native installation must remain untouched");
  await assert.rejects(invokeModeck(fixture, "recover", "claude"), error => {
    assert.equal(error.code, 4);
    assert.match(error.stderr, /unowned same-name native plugin/u);
    return true;
  });
  assert.ok(nativeRows((await invokeNative(fixture, "claude", ["plugin", "list", "--json"])).stdout)
    .some(item => item.id === pluginId));

  const journalFile = statePath(fixture);
  const journal = JSON.parse(await readFile(journalFile, "utf8"));
  assert.equal(journal.stage, "marketplace-added");
  journal.plugins[0].phase = "installing";
  delete journal.plugins[0].fingerprint;
  await writeFile(journalFile, JSON.stringify(journal));
  const installingIntent = await readFile(journalFile);
  await assert.rejects(invokeModeck(fixture, "recover", "claude"), error => {
    assert.equal(error.code, 4);
    assert.match(error.stderr, /Install intent has no native ownership fingerprint/u);
    return true;
  });
  assert.deepEqual(await readFile(journalFile), installingIntent,
    "recovery must preserve an installing intent without a native result fingerprint");
  assert.ok(nativeRows((await invokeNative(fixture, "claude", ["plugin", "list", "--json"])).stdout)
    .some(item => item.id === pluginId), "recovery must preserve the same-catalog external installation");

  await invokeNative(fixture, "claude", ["plugin", "uninstall", pluginId,
    "--keep-data", "--scope", "user", "--json", "-y"]);
  const recovered = JSON.parse((await invokeModeck(fixture, "recover", "claude")).stdout);
  assert.equal(recovered.outcome, "recovered");
  assert.equal(nativeRows((await invokeNative(fixture, "claude", ["plugin", "list", "--json"])).stdout)
    .some(item => item.id === pluginId), false);
  const marketplaces = JSON.parse((await invokeNative(fixture, "claude", ["plugin", "marketplace", "list", "--json"])).stdout);
  assert.equal((Array.isArray(marketplaces) ? marketplaces : marketplaces.marketplaces ?? [])
    .some(item => item.name === marketplace), false);
});

test("owned Claude repair refuses a same-name plugin installed from another marketplace", async t => {
  const fixture = await createPluginFixture(t, { claudeOnly: true });
  await invokeModeck(fixture, "init", "claude");
  const applied = JSON.parse((await invokeModeck(fixture, "apply", "claude")).stdout);
  const ownedId = `modeck-fixture@${applied.marketplace}`;
  const marketplace = join(fixture.root, "unmanaged-repair-marketplace");
  const plugin = join(marketplace, "plugins", "fixture");
  await mkdir(join(marketplace, ".claude-plugin"), { recursive: true });
  await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
  await writeFile(join(marketplace, ".claude-plugin/marketplace.json"), JSON.stringify({
    name: "unmanaged-repair", owner: { name: "test" }, plugins: [{ name: "modeck-fixture", source: "./plugins/fixture" }],
  }));
  await writeFile(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "modeck-fixture", version: "1.0.0" }));
  await invokeNative(fixture, "claude", ["plugin", "uninstall", ownedId, "--keep-data", "--scope", "user", "--json", "-y"]);
  await invokeNative(fixture, "claude", ["plugin", "marketplace", "add", marketplace, "--scope", "user", "--json"]);
  await invokeNative(fixture, "claude", ["plugin", "install", "modeck-fixture@unmanaged-repair",
    "--scope", "user", "--json", "-y"]);
  await assert.rejects(invokeModeck(fixture, "apply", "claude"), error => {
    assert.equal(error.code, 4);
    assert.match(error.stderr, /fingerprint drifted; refusing repair or replacement/u);
    return true;
  });
  const installed = nativeRows((await invokeNative(fixture, "claude", ["plugin", "list", "--json"])).stdout);
  assert.ok(installed.some(item => item.id === "modeck-fixture@unmanaged-repair"));
  assert.ok(!installed.some(item => item.id === ownedId));
});

test("recover rejects a journal marketplaceRoot tampered to point outside its owned generation", async t => {
  const fixture = await createPluginFixture(t, { claudeOnly: true });
  await invokeModeck(fixture, "init", "claude");
  await invokeModeck(fixture, "apply", "claude");
  const journalPath = statePath(fixture);
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  const decoy = join(fixture.root, "unowned-marketplace");
  await mkdir(decoy);
  await writeFile(join(decoy, "keep.txt"), "do not delete");
  journal.marketplaceRoot = decoy;
  await writeFile(journalPath, JSON.stringify(journal));
  await assert.rejects(invokeModeck(fixture, "recover", "claude"), error => {
    assert.equal(error.code, 4);
    assert.match(error.stderr, /journal marketplace path does not match/u);
    return true;
  });
  await assert.rejects(invokeModeck(fixture, "remove", "claude"), /journal marketplace path does not match/u);
  assert.equal(await readFile(join(decoy, "keep.txt"), "utf8"), "do not delete");
  assert.ok(nativeRows((await invokeNative(fixture, "claude", ["plugin", "list", "--json"])).stdout)
    .some(item => item.id === `modeck-fixture@${journal.marketplace}`));
});

test("apply refuses to overwrite an unowned marketplace generation already on disk", async t => {
  const fixture = await createPluginFixture(t, { claudeOnly: true });
  await invokeModeck(fixture, "init", "claude");
  await invokeModeck(fixture, "apply", "claude");
  await invokeModeck(fixture, "remove", "claude");
  const journalFile = statePath(fixture);
  const journal = JSON.parse(await readFile(journalFile, "utf8"));
  const sentinel = join(journal.marketplaceRoot, "unowned.txt");
  await writeFile(sentinel, "preserve foreign file");
  await rm(journalFile);
  await assert.rejects(invokeModeck(fixture, "apply", "claude"), error => {
    assert.equal(error.code, 4);
    assert.match(error.stderr, /exists without a matching ownership journal/u);
    return true;
  });
  assert.equal(await readFile(sentinel, "utf8"), "preserve foreign file");
});

test("plugin lifecycle releases its native state lock after SIGKILL so recover can enter", async t => {
  const fixture = await createPluginFixture(t, { claudeOnly: true });
  await invokeModeck(fixture, "init", "claude");
  const started = join(fixture.root, "install-started");
  const finished = join(fixture.root, "install-finished");
  const shim = join(fixture.root, "shim");
  await mkdir(shim);
  const { execFileSync } = await import("node:child_process");
  const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  const script = [
    "#!/bin/sh",
    'if [ "$1" = plugin ] && [ "$2" = install ]; then',
    "  touch \"" + started + "\"",
    "  sleep 2",
    "  touch \"" + finished + "\"",
    "  exit 42",
    "fi",
    "exec \"" + claudeBin + "\" \"$@\"",
    "",
  ].join("\n");
  await writeFile(join(shim, "claude"), script);
  await chmod(join(shim, "claude"), 0o700);
  fixture.nativePath = shim;
  const child = spawn(process.execPath, [modeckBin, "plugin", "apply", "--config", fixture.config,
    "--target-home", fixture.home, "--cwd", fixture.cwd, "--agent", "claude", "--format", "json"], {
    cwd: fixture.cwd, env: cliEnvironment(fixture, "claude"), stdio: "ignore",
  });
  let startedInstall = false;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try { await access(started); startedInstall = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.equal(startedInstall, true, "native install did not start before test timeout");
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    if (!child.kill("SIGKILL")) reject(new Error("failed to SIGKILL modeck apply process"));
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(finished); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  fixture.nativePath = undefined;
  const recovered = JSON.parse((await invokeModeck(fixture, "recover", "claude")).stdout);
  assert.equal(recovered.outcome, "recovered");
});

test("SIGKILL during native uninstall preserves removing stage for recovery", async t => {
  const fixture = await createPluginFixture(t, { claudeOnly: true });
  await invokeModeck(fixture, "init", "claude");
  const applied = JSON.parse((await invokeModeck(fixture, "apply", "claude")).stdout);
  const started = join(fixture.root, "uninstall-started");
  const finished = join(fixture.root, "uninstall-finished");
  const shim = join(fixture.root, "shim");
  await mkdir(shim);
  const { execFileSync } = await import("node:child_process");
  const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  const script = [
    "#!/bin/sh",
    'if [ "$1" = plugin ] && [ "$2" = uninstall ]; then',
    `  touch "${started}"`,
    "  sleep 2",
    `  touch "${finished}"`,
    "  exit 42",
    "fi",
    `exec "${claudeBin}" "$@"`,
    "",
  ].join("\n");
  await writeFile(join(shim, "claude"), script);
  await chmod(join(shim, "claude"), 0o700);
  fixture.nativePath = shim;
  const child = spawn(process.execPath, [modeckBin, "plugin", "remove", "--config", fixture.config,
    "--target-home", fixture.home, "--cwd", fixture.cwd, "--agent", "claude", "--format", "json"], {
    cwd: fixture.cwd, env: cliEnvironment(fixture, "claude"), stdio: "ignore",
  });
  let startedUninstall = false;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try { await access(started); startedUninstall = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.equal(startedUninstall, true, "native uninstall did not start before test timeout");
  const inFlight = JSON.parse(await readFile(statePath(fixture), "utf8"));
  assert.equal(inFlight.stage, "removing", "journal must remain in removing stage while native uninstall is in flight");
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    if (!child.kill("SIGKILL")) reject(new Error("failed to SIGKILL modeck remove process"));
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(finished); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  fixture.nativePath = undefined;
  const recovered = JSON.parse((await invokeModeck(fixture, "recover", "claude")).stdout);
  assert.equal(recovered.outcome, "recovered");
  assert.equal(nativeRows((await invokeNative(fixture, "claude", ["plugin", "list", "--json"])).stdout)
    .some(item => item.id === `modeck-fixture@${applied.marketplace}`), false);
  const marketplaces = JSON.parse((await invokeNative(fixture, "claude", ["plugin", "marketplace", "list", "--json"])).stdout);
  assert.equal((Array.isArray(marketplaces) ? marketplaces : marketplaces.marketplaces ?? [])
    .some(item => item.name === applied.marketplace), false);
});

test("Codex native marketplace preserves portable root manifests, MCP identity, and removes its installation", async t => {
  const fixture = await createPluginFixture(t, { codexOnly: true });
  await invokeModeck(fixture, "init", "codex");
  const context = await loadConfig({ configRoot: fixture.config });
  const [bundle] = await readPluginBundles(context);
  const projection = await projectPlugin(bundle, "codex", join(fixture.root, "codex-projection"));
  const mcp = JSON.parse(await readFile(join(projection.root, "mcp.json"), "utf8"));
  assert.ok(mcp.mcpServers["fixture-api"]);
  assert.equal(mcp.mcpServers["fixture-api"].args[0], "${PLUGIN_ROOT}/server.mjs");
  assert.equal(mcp.mcpServers["fixture-api"].env.TOKEN, "${PLUGIN_TEST_TOKEN}");
  assert.equal(projection.components.includes("hooks"), false);
  await assert.rejects(readFile(join(projection.root, "hooks/hooks.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(projection.root, "skills/guide/SKILL.md")), { code: "ENOENT" });
  await assert.rejects(readFile(join(projection.root, "skills/reference/SKILL.md")), { code: "ENOENT" });
  await writeFile(join(fixture.cwd, ".modes"), "selected\n");
  const rendered = JSON.parse((await invokeModeckArgs(fixture, ["render", "--config", fixture.config, "--state", fixture.state,
    "--cwd", fixture.cwd, "--agent", "codex", "--format", "json"], "codex")).stdout).text;
  const skillRecord = JSON.parse(rendered.split("\n").find(line => line.startsWith('{"description":"Plugin guide skill",')));
  const skillText = await readFile(skillRecord.entry, "utf8");
  const lockedRoot = join(fixture.config, "vendor", "plugins", "fixture", (await fixture.readLock()).plugins[0].treeDigest);
  assert.ok(skillText.includes(`${lockedRoot}/assets/prompt.txt`));
  assert.doesNotMatch(skillText, /\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/u);
  const applied = JSON.parse((await invokeModeck(fixture, "apply", "codex")).stdout);
  assert.equal(applied.outcome, "applied");
  const listed = await invokeNative(fixture, "codex", ["plugin", "list", "--json"]);
  assert.match(listed.stdout, /modeck-fixture/);
  const installed = JSON.parse(listed.stdout).installed[0];
  assert.ok(installed);
  const installedMcp = JSON.parse(await readFile(join(installed.source.path, "mcp.json"), "utf8"));
  assert.ok(installedMcp.mcpServers["fixture-api"]);
  assert.equal(installedMcp.mcpServers["fixture-api"].args[0], "${PLUGIN_ROOT}/server.mjs");
  assert.equal(installedMcp.mcpServers["fixture-api"].env.TOKEN, "${PLUGIN_TEST_TOKEN}");
  const schemaDir = join(fixture.root, "app-server-schema");
  await invokeNative(fixture, "codex", ["app-server", "generate-json-schema", "--out", schemaDir]);
  const requestSchema = await readFile(join(schemaDir, "ClientRequest.json"), "utf8");
  for (const method of ["plugin/read", "skills/list", "mcpServerStatus/list"]) assert.ok(requestSchema.includes(method));
  const marketplaces = JSON.parse((await invokeNative(fixture, "codex", ["plugin", "marketplace", "list", "--json"])).stdout);
  const marketplaceRoot = marketplaces.marketplaces.find(item => item.name === installed.marketplaceName)?.root;
  assert.ok(marketplaceRoot);
  const runtime = await invokeCodexAppServer(fixture, [
    { name: "pluginList", method: "plugin/list", params: {} },
    { name: "plugin", method: "plugin/read", params: { pluginName: "modeck-fixture", marketplacePath: join(marketplaceRoot, ".agents/plugins/marketplace.json") } },
    { name: "skills", method: "skills/list", params: { cwds: [fixture.cwd], forceReload: true } },
    { name: "mcp", method: "mcpServerStatus/list", params: { serverName: "fixture-api" } },
  ]);
  const pluginDetail = runtime.plugin.plugin;
  assert.ok(JSON.stringify(runtime.pluginList).includes("modeck-fixture"));
  assert.equal(pluginDetail.summary.enabled, true);
  assert.equal(pluginDetail.summary.installed, true);
  assert.ok(pluginDetail.mcpServers.includes("fixture-api"));
  assert.equal(pluginDetail.skills.some(skill => /guide|reference/u.test(skill.name)), false);
  assert.equal(runtime.skills.data.flatMap(entry => entry.skills).some(skill => /guide|reference/u.test(skill.name)), false);
  assert.ok(runtime.mcp.data.some(server => server.name === "fixture-api" && server.pluginId));
  const promptInput = await invokeNative(fixture, "codex", ["debug", "prompt-input"], { timeout: 20_000 });
  assert.doesNotMatch(promptInput.stdout, /Plugin guide skill|Plugin reference skill|Plugin guide content|Plugin reference content|Selected fixture rule/u);
  const removed = JSON.parse((await invokeModeck(fixture, "remove", "codex")).stdout);
  assert.equal(removed.outcome, "removed");
  assert.doesNotMatch((await invokeNative(fixture, "codex", ["plugin", "list", "--json"])).stdout, /modeck-fixture/u);
});

test("Codex recovery refuses to remove a plugin after its native cache contents drift", async t => {
  const fixture = await createPluginFixture(t, { codexOnly: true });
  await invokeModeck(fixture, "init", "codex");
  await invokeModeck(fixture, "apply", "codex");
  const journalPath = statePath(fixture, "codex");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  const cacheFile = join(journal.plugins[0].fingerprint.installPath, "mcp.json");
  const original = await readFile(cacheFile, "utf8");
  await writeFile(cacheFile, original.replace("fixture-api", "modified-api"));
  for (const action of ["remove", "recover"]) {
    await assert.rejects(invokeModeck(fixture, action, "codex"), error => {
      assert.equal(error.code, 4);
      assert.match(error.stderr, /verified marketplace cache tree/u);
      return true;
    });
  }
  assert.ok(nativeRows((await invokeNative(fixture, "codex", ["plugin", "list", "--json"])).stdout)
    .some(item => item.name === "modeck-fixture"));
  await writeFile(cacheFile, original);
});

test("Codex recovers a partially applied native marketplace without leaving it installed", async t => {
  const fixture = await createPluginFixture(t, { codexOnly: true });
  await invokeModeck(fixture, "init", "codex");
  const shim = join(fixture.root, "shim");
  await mkdir(shim);
  const { execFile: callback } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = promisify(callback);
  const { stdout: codexBin } = await execFile("which", ["codex"]);
  await writeFile(join(shim, "codex"), `#!/bin/sh\nif [ "$1" = plugin ] && [ "$2" = add ] && [ "$HOME" = "${fixture.home}" ]; then exit 42; fi\nexec ${codexBin.trim()} "$@"\n`);
  await chmod(join(shim, "codex"), 0o700);
  fixture.nativePath = shim;
  await assert.rejects(invokeModeck(fixture, "apply", "codex"), error => {
    assert.equal(error.code, 3);
    return true;
  });
  fixture.nativePath = undefined;
  const recovered = JSON.parse((await invokeModeck(fixture, "recover", "codex")).stdout);
  assert.equal(recovered.outcome, "recovered");
  const installed = JSON.parse((await invokeNative(fixture, "codex", ["plugin", "list", "--json"])).stdout);
  assert.equal(nativeRows(JSON.stringify(installed)).some(item => item.name === "modeck-fixture"), false);
  const marketplaces = JSON.parse((await invokeNative(fixture, "codex", ["plugin", "marketplace", "list", "--json"])).stdout);
  assert.equal(marketplaces.marketplaces.some(item => item.name === recovered.marketplace), false,
    "recovery must remove its registered marketplace after confirming no plugin was installed");
});

test("remove then apply installs an updated pin into a new preserved marketplace generation", async t => {
  const fixture = await createPluginFixture(t, { codexOnly: true });
  await invokeModeck(fixture, "init", "codex");
  await invokeModeck(fixture, "apply", "codex");
  const statePath = join(fixture.home, ".local", "share", "modeck", "plugins",
    createHash("sha256").update(fixture.config).digest("hex"), "codex", "state.json");
  const previous = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(join(fixture.source, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "modeck-fixture", version: "1.0.1",
  }));
  await repinPluginFixture(fixture);
  await invokeModeck(fixture, "init", "codex");
  await invokeModeck(fixture, "remove", "codex");
  const applied = JSON.parse((await invokeModeck(fixture, "apply", "codex")).stdout);
  const current = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(applied.outcome, "applied");
  assert.notEqual(current.generation, previous.generation);
  assert.notEqual(current.marketplaceRoot, previous.marketplaceRoot);
  await access(previous.marketplaceRoot);
  await access(current.marketplaceRoot);
  assert.match((await invokeNative(fixture, "codex", ["plugin", "list", "--json"])).stdout, /modeck-fixture/u);
});

test("Codex legacy MCP root variables resolve to absolute paths and the native server handshakes", async t => {
  const fixture = await createPluginFixture(t, { portable: false, codexOnly: true });
  await writeFile(join(fixture.source, ".codex-plugin/plugin.json"), JSON.stringify({ name: "modeck-fixture",
    version: "1.0.0", mcpServers: {
      "fixture-api": { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.mjs"], env: { TOKEN: "${PLUGIN_TEST_TOKEN}" } },
    } }));
  await repinPluginFixture(fixture);
  await invokeModeck(fixture, "init", "codex");
  const context = await loadConfig({ configRoot: fixture.config });
  const [bundle] = await readPluginBundles(context);
  const projection = await projectPlugin(bundle, "codex", join(fixture.root, "legacy-projection"));
  await assert.rejects(readFile(join(projection.root, "plugin.json")), { code: "ENOENT" });
  assert.match(await readFile(join(projection.root, ".codex-plugin/plugin.json"), "utf8"), /modeck-fixture/u);
  const projectedManifest = JSON.parse(await readFile(join(projection.root, ".codex-plugin/plugin.json"), "utf8"));
  assert.equal(projectedManifest.mcpServers["fixture-api"].args[0], join(bundle.root, "server.mjs"));
  assert.doesNotMatch(projectedManifest.mcpServers["fixture-api"].args[0], /\$\{PLUGIN_ROOT\}/u);
  const applied = JSON.parse((await invokeModeck(fixture, "apply", "codex")).stdout);
  assert.equal(applied.outcome, "applied");
  assert.match((await invokeNative(fixture, "codex", ["plugin", "list", "--json"])).stdout, /modeck-fixture/u);
  const marketplaces = JSON.parse((await invokeNative(fixture, "codex", ["plugin", "marketplace", "list", "--json"])).stdout);
  const marketplaceRoot = marketplaces.marketplaces.find(item => item.name === applied.marketplace)?.root;
  assert.ok(marketplaceRoot);
  const runtime = await invokeCodexAppServer(fixture, [
    { name: "plugin", method: "plugin/read", params: { pluginName: "modeck-fixture",
      marketplacePath: join(marketplaceRoot, ".agents/plugins/marketplace.json") } },
    { name: "hooks", method: "hooks/list", params: { cwds: [fixture.cwd] } },
    { name: "thread", method: "thread/start", params: { cwd: fixture.cwd, ephemeral: true, sandbox: "read-only" } },
    { name: "mcpStatus", method: "mcpServerStatus/list", params: async results => {
      await new Promise(resolve => setTimeout(resolve, 500));
      return { threadId: results.thread.thread.id, serverName: "fixture-api" };
    } },
  ]);
  const plugin = runtime.plugin.plugin;
  assert.equal(plugin.summary.installed, true);
  assert.equal(plugin.summary.enabled, true);
  assert.deepEqual(plugin.hooks, []);
  assert.deepEqual(plugin.mcpServers, ["fixture-api"]);
  const cwdHooks = runtime.hooks.data.find(item => item.cwd === fixture.cwd)?.hooks ?? [];
  assert.equal(cwdHooks.some(hook => hook.pluginId === "modeck-fixture@" + applied.marketplace), false);
  const mcp = runtime.mcpStatus.data.find(server => server.name === "fixture-api");
  assert.ok(mcp, "Codex must expose the plugin MCP server status");
  assert.equal(mcp.runtimeStatus, "connected", "the real stdio server must complete initialize and tools/list");
  assert.equal(mcp.pluginId, "modeck-fixture@" + applied.marketplace);
  assert.deepEqual(runtime.thread.thread.turns, [], "MCP startup verification must not send a model turn");
  assert.ok(runtime.notifications.some(event => event.method === "mcpServer/startupStatus/updated"
    && event.params.name === "fixture-api" && event.params.status === "ready"),
  "Codex must emit native MCP startup ready after the legacy server handshake");
});

test("Codex legacy hooks are visible to the CLI while trust remains untrusted", async t => {
  const fixture = await createPluginFixture(t, { portable: false, codexOnly: true });
  await writeFile(join(fixture.source, ".codex-plugin/plugin.json"), JSON.stringify({ name: "modeck-fixture",
    version: "1.0.0", hooks: "./hooks/hooks.json" }));
  await mkdir(join(fixture.source, "hooks"), { recursive: true });
  await writeFile(join(fixture.source, "hooks/hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [
    { type: "command", command: 'node "${PLUGIN_ROOT}/hooks/write-marker.mjs"', timeout: 10_000 },
  ] }] } }));
  await writeFile(join(fixture.source, "hooks/write-marker.mjs"), `import { writeFile } from "node:fs/promises";
import { join } from "node:path";
await writeFile(join(process.env.HOME, "modeck-plugin-hook-marker"), "session started\\n", { mode: 0o600 });
`);
  await repinPluginFixture(fixture);
  await invokeModeck(fixture, "init", "codex");
  const context = await loadConfig({ configRoot: fixture.config });
  const [bundle] = await readPluginBundles(context);
  const projection = await projectPlugin(bundle, "codex", join(fixture.root, "legacy-hooks-projection"));
  assert.ok(projection.components.includes("hooks"));
  assert.equal(JSON.parse(await readFile(join(projection.root, "hooks/hooks.json"), "utf8"))
    .hooks.SessionStart[0].hooks[0].type, "command");
  const applied = JSON.parse((await invokeModeck(fixture, "apply", "codex")).stdout);
  assert.equal(applied.outcome, "applied");
  const marketplaces = JSON.parse((await invokeNative(fixture, "codex", ["plugin", "marketplace", "list", "--json"])).stdout);
  const marketplaceRoot = marketplaces.marketplaces.find(item => item.name === applied.marketplace)?.root;
  assert.ok(marketplaceRoot);
  const runtime = await invokeCodexAppServer(fixture, [
    { name: "plugin", method: "plugin/read", params: { pluginName: "modeck-fixture",
      marketplacePath: join(marketplaceRoot, ".agents/plugins/marketplace.json") } },
    { name: "hooks", method: "hooks/list", params: { cwds: [fixture.cwd] } },
  ]);
  const plugin = runtime.plugin.plugin;
  assert.deepEqual(plugin.hooks.map(hook => hook.eventName), ["sessionStart"]);
  const cwdHooks = runtime.hooks.data.find(item => item.cwd === fixture.cwd)?.hooks ?? [];
  const loaded = cwdHooks.find(hook => hook.pluginId === "modeck-fixture@" + applied.marketplace);
  assert.ok(loaded, "Codex hooks/list must expose the legacy plugin hook");
  assert.equal(loaded.source, "plugin");
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.trustStatus, "untrusted");
});

test("Codex loader preflight rejects a malformed legacy MCP server before target installation", async t => {
  const fixture = await createPluginFixture(t, { portable: false, codexOnly: true });
  const manifestPath = join(fixture.source, ".codex-plugin/plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.mcpServers = { "malformed-api": { type: "stdio", env: { TOKEN: "mcp-private-value" } } };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await repinPluginFixture(fixture);
  await invokeModeck(fixture, "init", "codex");
  await assert.rejects(invokeModeck(fixture, "apply", "codex"), error => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /silently omitted or changed projected MCP/u);
    assert.doesNotMatch(error.stderr, /mcp-private-value/u);
    return true;
  });
  const rows = nativeRows((await invokeNative(fixture, "codex", ["plugin", "list", "--json"])).stdout);
  assert.equal(rows.some(plugin => plugin.name === "modeck-fixture"), false,
    "a rejected malformed legacy MCP server must not remain installed in the target Codex home");
});

test("Codex loader preflight rejects an unverified plugin skill surface before target installation", async t => {
  const fixture = await createPluginFixture(t, { codexOnly: true });
  const manifestPath = join(fixture.source, "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.extensions = { "com.openai": { onboardingSkill: "./onboarding.md" } };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(fixture.source, "onboarding.md"), "A plugin onboarding skill that must not leak into mode skills.\n");
  await repinPluginFixture(fixture);
  await assertCodexPreflightRejectsWithoutTargetInstall(fixture, /outside the verified MCP and hook loaders/u);
});

test("Codex fails closed on default-scanned app assets before target installation", async t => {
  const fixture = await createPluginFixture(t, { codexOnly: true });
  await writeFile(join(fixture.source, ".app.json"), JSON.stringify({ name: "unverified-app" }));
  await repinPluginFixture(fixture);
  await assertCodexPreflightRejectsWithoutTargetInstall(fixture, /cannot safely load default-scanned native components/u);
});

test("Codex refuses plugin manifests that declare unsupported native components", async t => {
  const fixture = await createPluginFixture(t, { codexOnly: true });
  const manifestPath = join(fixture.source, "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.commands = ["./commands"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await repinPluginFixture(fixture);
  await invokeModeck(fixture, "init", "codex");
  await assert.rejects(invokeModeck(fixture, "apply", "codex"), error => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /does not support.*component/u);
    return true;
  });
  const listed = JSON.parse((await invokeNative(fixture, "codex", ["plugin", "list", "--json"])).stdout);
  assert.equal(nativeRows(JSON.stringify(listed)).some(item => item.name === "modeck-fixture"), false);
});

test("Codex rejects portable plugin-level auth while preserving MCP env and headers", async t => {
  const fixture = await createPluginFixture(t, { codexOnly: true });
  const manifestPath = join(fixture.source, "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.extensions = { "com.openai": { auth: { id: "fixture-auth", type: "oauth" } } };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const mcpPath = join(fixture.source, "mcp.json");
  const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
  mcp.mcpServers["fixture-http"] = { type: "streamable-http", url: "http://127.0.0.1:43123/mcp",
    headers: { Authorization: "Bearer ${FIXTURE_MCP_TOKEN}" } };
  await writeFile(mcpPath, JSON.stringify(mcp));
  await repinPluginFixture(fixture);
  await invokeModeck(fixture, "init", "codex");
  let context = await loadConfig({ configRoot: fixture.config });
  let [bundle] = await readPluginBundles(context);
  await assert.rejects(projectPlugin(bundle, "codex", join(fixture.root, "portable-auth-projection")), error => {
    assert.match(error.message, /does not load extensions\.com\.openai\.auth/u);
    assert.match(error.message, /refusing to imply native authentication is configured/u);
    return true;
  });

  delete manifest.extensions["com.openai"].auth;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await repinPluginFixture(fixture);
  await invokeModeck(fixture, "init", "codex");
  context = await loadConfig({ configRoot: fixture.config });
  [bundle] = await readPluginBundles(context);
  const projection = await projectPlugin(bundle, "codex", join(fixture.root, "portable-mcp-auth-projection"));
  const projectedMcp = JSON.parse(await readFile(join(projection.root, "mcp.json"), "utf8"));
  assert.equal(projectedMcp.mcpServers["fixture-api"].env.TOKEN, "${PLUGIN_TEST_TOKEN}");
  assert.deepEqual(projectedMcp.mcpServers["fixture-http"].headers,
    { Authorization: "Bearer ${FIXTURE_MCP_TOKEN}" });
});

test("apply rejects duplicate MCP server names across configured plugins before installation", async t => {
  const fixture = await createPluginFixture(t, { claudeOnly: true });
  await addClaudePlugin(fixture, { id: "second", name: "modeck-second", serverName: "fixture-api" });
  await invokeModeck(fixture, "init", "claude");
  await assert.rejects(invokeModeck(fixture, "apply", "claude"), error => {
    assert.equal(error.code, 4);
    assert.match(error.stderr, /Configured plugins declare the same native MCP server name/u);
    assert.doesNotMatch(error.stderr, /PLUGIN_TEST_TOKEN|fixture-secret|Bearer /u);
    return true;
  });
  assert.equal(nativeRows((await invokeNative(fixture, "claude", ["plugin", "list", "--json"])).stdout)
    .some(plugin => plugin.name === "modeck-fixture" || plugin.name === "modeck-second"), false);
});

test("apply rejects MCP names already configured for Claude without exposing credentials", async t => {
  for (const scope of ["user", "cwd"]) await t.test(scope, async t => {
    const fixture = await createPluginFixture(t, { claudeOnly: true });
    const configPath = scope === "user" ? join(fixture.home, ".claude", ".claude.json") : join(fixture.cwd, ".mcp.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: {
      "fixture-api": { command: "node", args: ["server.mjs"], env: { TOKEN: "fixture-private-value" } },
    } }));
    await invokeModeck(fixture, "init", "claude");
    await assert.rejects(invokeModeck(fixture, "apply", "claude"), error => {
      assert.equal(error.code, 4);
      assert.match(error.stderr, /Native MCP server name is already visible to this agent/u);
      assert.doesNotMatch(error.stderr, /fixture-private-value|PLUGIN_TEST_TOKEN|Bearer /u);
      return true;
    });
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).mcpServers, {
      "fixture-api": { command: "node", args: ["server.mjs"], env: { TOKEN: "fixture-private-value" } },
    }, "preflight must preserve the conflicting native MCP definition");
    assert.equal(nativeRows((await invokeNative(fixture, "claude", ["plugin", "list", "--json"])).stdout)
      .some(item => item.name === "modeck-fixture" || item.id?.startsWith("modeck-fixture@")), false,
    "a conflicting native MCP name must block managed plugin installation");
  });
});

test("apply rejects MCP names from another installed Claude plugin without exposing credentials", async t => {
  const fixture = await createPluginFixture(t, { claudeOnly: true });
  const marketplace = join(fixture.root, "unmanaged-mcp-marketplace");
  const plugin = join(marketplace, "plugins", "unmanaged-api");
  await mkdir(join(marketplace, ".claude-plugin"), { recursive: true });
  await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
  await writeFile(join(marketplace, ".claude-plugin/marketplace.json"), JSON.stringify({
    name: "unmanaged-mcp", owner: { name: "test" },
    plugins: [{ name: "unmanaged-api", source: "./plugins/unmanaged-api" }],
  }));
  await writeFile(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "unmanaged-api", version: "1.0.0" }));
  await writeFile(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: {
    "fixture-api": { command: "node", args: ["server.mjs"], env: { TOKEN: "installed-private-value" } },
  } }));
  await invokeNative(fixture, "claude", ["plugin", "marketplace", "add", marketplace, "--scope", "user", "--json"]);
  await invokeNative(fixture, "claude", ["plugin", "install", "unmanaged-api@unmanaged-mcp",
    "--scope", "user", "--json", "-y"]);
  await invokeModeck(fixture, "init", "claude");
  await assert.rejects(invokeModeck(fixture, "apply", "claude"), error => {
    assert.equal(error.code, 4);
    assert.match(error.stderr, /Native MCP server name is already visible to this agent/u);
    assert.doesNotMatch(error.stderr, /installed-private-value|PLUGIN_TEST_TOKEN|Bearer /u);
    return true;
  });
  assert.ok(nativeRows((await invokeNative(fixture, "claude", ["plugin", "list", "--json"])).stdout)
    .some(item => item.name === "unmanaged-api" || item.id === "unmanaged-api@unmanaged-mcp"),
  "preflight must preserve the conflicting externally installed plugin");
  assert.equal(nativeRows((await invokeNative(fixture, "claude", ["plugin", "list", "--json"])).stdout)
    .some(item => item.name === "modeck-fixture"), false, "the conflicting MCP name must block managed installation");
});

test("apply succeeds when configured MCP names do not collide", async t => {
  const fixture = await createPluginFixture(t, { claudeOnly: true });
  await addClaudePlugin(fixture, { id: "second", name: "modeck-second", serverName: "second-api" });
  await invokeModeck(fixture, "init", "claude");
  const applied = JSON.parse((await invokeModeck(fixture, "apply", "claude")).stdout);
  assert.equal(applied.outcome, "applied");
  const installed = nativeRows((await invokeNative(fixture, "claude", ["plugin", "list", "--json"])).stdout);
  assert.ok(installed.some(plugin => plugin.name === "modeck-fixture"));
  assert.ok(installed.some(plugin => plugin.name === "modeck-second"));
  assert.equal(JSON.parse((await invokeModeck(fixture, "remove", "claude")).stdout).outcome, "removed");
});

test("Codex portable manifest and extensions take precedence over legacy component declarations", async t => {
  const fixture = await createPluginFixture(t, { codexOnly: true });
  const portablePath = join(fixture.source, "plugin.json");
  const portable = JSON.parse(await readFile(portablePath, "utf8"));
  portable.extensions = { "com.openai": { interface: { displayName: "Portable fixture" } } };
  await writeFile(portablePath, JSON.stringify(portable));
  const legacyPath = join(fixture.source, ".codex-plugin/plugin.json");
  await writeFile(legacyPath, JSON.stringify({ name: "modeck-fixture", commands: ["./missing-legacy-command"],
    agents: ["./missing-legacy-agent"], lspServers: ["./missing-legacy-lsp"] }));
  await repinPluginFixture(fixture);
  await invokeModeck(fixture, "init", "codex");
  const context = await loadConfig({ configRoot: fixture.config });
  const [bundle] = await readPluginBundles(context);
  const projection = await projectPlugin(bundle, "codex", join(fixture.root, "portable-precedence-projection"));
  assert.deepEqual(projection.components, ["mcpServers"]);
  const effective = JSON.parse(await readFile(join(projection.root, "plugin.json"), "utf8"));
  assert.equal(effective.extensions["com.openai"].interface.displayName, "Portable fixture");
  assert.equal(effective.commands, undefined);
  assert.equal(effective.agents, undefined);
  assert.equal(effective.lspServers, undefined);
});

test("Codex refuses default-scanned commands, agents, and LSP assets instead of silently dropping them", async t => {
  const cases = [
    ["commands", "commands/check.md", "default command"],
    ["agents", "agents/reviewer.md", "default agent"],
    ["LSP", ".lsp.json", "{}"],
  ];
  for (const [label, relative, content] of cases) await t.test(label, async t => {
    const fixture = await createPluginFixture(t, { codexOnly: true });
    const path = join(fixture.source, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    await repinPluginFixture(fixture);
    await invokeModeck(fixture, "init", "codex");
    await assert.rejects(invokeModeck(fixture, "apply", "codex"), error => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /cannot safely load default-scanned native components/u);
      return true;
    });
    assert.equal(JSON.parse((await invokeNative(fixture, "codex", ["plugin", "list", "--json"])).stdout)
      .installed.some(item => item.name === "modeck-fixture"), false);
  });
});

test("Codex portable hook declarations fail closed when its CLI loader omits them", async t => {
  const fixture = await createPluginFixture(t, { codexOnly: true });
  const manifestPath = join(fixture.source, "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.extensions = { "com.openai": { hooks: "./hooks/hooks.json" } };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await mkdir(join(fixture.source, "hooks"), { recursive: true });
  await writeFile(join(fixture.source, "hooks/hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [
    { type: "command", command: 'node "${PLUGIN_ROOT}/hooks/write-marker.mjs"', timeout: 10_000 },
  ] }] } }));
  await writeFile(join(fixture.source, "hooks/write-marker.mjs"), `import { writeFile } from "node:fs/promises";
import { join } from "node:path";
await writeFile(join(process.env.HOME, "modeck-plugin-hook-marker"), "session started\\n", { mode: 0o600 });
`);
  await repinPluginFixture(fixture);
  await invokeModeck(fixture, "init", "codex");
  await assert.rejects(invokeModeck(fixture, "apply", "codex"), /does not load declared lifecycle hooks/u);
});
