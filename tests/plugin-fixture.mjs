import { access, chmod, cp, lstat, mkdtemp, mkdir, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const testRuntime = await realpath(await mkdtemp(join(await realpath(tmpdir()), "modeck-plugin-runtime-")));
process.once("exit", () => rmSync(testRuntime, { recursive: true, force: true }));
const distSource = join(projectRoot, "dist");
const distSnapshot = join(testRuntime, "dist.snapshot");
let distReady = false;
for (let attempt = 0; attempt < 120 && !distReady; attempt += 1) {
  try {
    await access(join(distSource, "bin/modeck.mjs"));
    await cp(distSource, distSnapshot, { recursive: true, errorOnExist: true });
    for (const path of ["bin/modeck.mjs", "core/index.js", "plugins/projection.js", "plugins/manage.js",
      "plugins/dynamic.js", "resources/index.js", "integration/prepare.js"]) {
      await access(join(distSnapshot, path));
      await access(join(distSource, path));
    }
    await rename(distSnapshot, join(testRuntime, "dist"));
    distReady = true;
  } catch (error) {
    await rm(distSnapshot, { recursive: true, force: true });
    if (!(error instanceof Error && "code" in error && ["ENOENT", "EBUSY"].includes(String(error.code)))) throw error;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
if (!distReady) throw new Error("Could not snapshot a complete dist; wait for build to finish before plugin tests");
await cp(join(projectRoot, "schemas"), join(testRuntime, "schemas"), { recursive: true });
await symlink(join(projectRoot, "node_modules"), join(testRuntime, "node_modules"), "dir");
export const modeckBin = join(testRuntime, "dist/bin/modeck.mjs");
const [core, bundle, projection, integration] = await Promise.all([
  import(pathToFileURL(join(testRuntime, "dist/core/index.js")).href),
  import(pathToFileURL(join(testRuntime, "dist/plugins/bundle.js")).href),
  import(pathToFileURL(join(testRuntime, "dist/plugins/projection.js")).href),
  import(pathToFileURL(join(testRuntime, "dist/integration/prepare.js")).href),
]);
const [resourcesModule, dynamic] = await Promise.all([
  import(pathToFileURL(join(testRuntime, "dist/resources/index.js")).href),
  import(pathToFileURL(join(testRuntime, "dist/plugins/dynamic.js")).href),
]);
export const { loadConfig } = core;
export const { readPluginBundles } = bundle;
export const { projectPlugin } = projection;
export const { prepare } = integration;
export const loadDynamicPluginResources = async (fixture, agent = "claude") => {
  const context = await core.loadConfig({ configRoot: fixture.config });
  const facts = await core.collectFacts({ cwd: fixture.cwd, stateRoot: fixture.state });
  const selection = core.resolve({ context, facts, resourceDigest: "0".repeat(64) });
  const base = await resourcesModule.readResources({ context, stateRoot: fixture.state, parseManifest: core.parseManifest,
    resourceIds: selection.resources.map(resource => resource.id) });
  const plan = core.resolve({ context, facts, resourceDigest: base.resourceDigest });
  return dynamic.attachDynamicPlugins(context, plan, base, fixture.state, agent);
};

const removeFixture = async root => {
  const writable = async path => {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await writable(join(path, name));
  };
  await writable(root);
  await rm(root, { recursive: true, force: true });
};

export const createPluginFixture = async (t, { portable = true, claudeOnly = false, codexOnly = false } = {}) => {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), "modeck-plugin-test-")));
  t.after(() => removeFixture(root));
  const config = join(root, "config");
  const source = join(config, "source");
  const cwd = join(root, "project");
  const home = join(root, "home");
  const state = join(root, "state");
  for (const path of [config, source, cwd, home, state]) {
    await mkdir(path, { recursive: true });
  }
  for (const path of [join(home, ".claude"), join(home, ".codex")]) {
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
    if ((await stat(path)).mode & 0o077) throw new Error(`Native fixture directory permissions are too broad: ${path}`);
  }
  const files = {
    "plugin.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "modeck-fixture", version: "1.0.0" }),
    ".claude-plugin/plugin.json": JSON.stringify({ name: "modeck-fixture", version: "1.0.0",
      description: "Isolated native inventory fixture", author: { name: "Modeck Test" },
      skills: ["./skills/"], commands: ["./commands/"], agents: ["./agents/reviewer.md"],
      hooks: "./hooks/hooks.json", lspServers: "./.lsp.json" }),
    ".codex-plugin/plugin.json": JSON.stringify({ name: "modeck-fixture" }),
    "skills/guide/SKILL.md": "---\nname: guide\ndescription: Plugin guide skill\n---\nPlugin guide content.\nRead assets at ${CLAUDE_PLUGIN_ROOT}/assets/prompt.txt and ${PLUGIN_ROOT}/assets/prompt.txt.\nRun ${CLAUDE_PLUGIN_ROOT}/scripts/support.sh and ${PLUGIN_ROOT}/scripts/support.sh.\n",
    "skills/guide/assets/payload.bin": Buffer.from([0, 255, 17, 0, 128]),
    "skills/reference/SKILL.md": "---\nname: reference\ndescription: Plugin reference skill\n---\nPlugin reference content.\n",
    "rules/policy.md": "Selected fixture rule.\n",
    "commands/check.md": "---\ndescription: Native command\n---\nCheck fixture.\n",
    "commands/SKILL.md": "---\ndescription: Static command whose filename is SKILL.md\n---\nRetain this as a native command, not a mode-selected skill.\n",
    "agents/reviewer.md": "---\nname: reviewer\ndescription: Reviews isolated fixture changes for correctness and safety.\nmodel: inherit\n---\nReview fixture changes and report concrete findings.\n",
    "hooks/hooks.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [
      { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/write-marker.mjs"', timeout: 10_000 },
    ] }] } }),
    "hooks/write-marker.mjs": `import { writeFile } from "node:fs/promises";
import { join } from "node:path";
await writeFile(join(process.env.HOME, "modeck-plugin-hook-marker"), "session started\\n", { mode: 0o600 });
`,
    ".lsp.json": JSON.stringify({ "fixture-lsp": { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/lsp-server.mjs"],
      extensionToLanguage: { ".fixture": "modeck-fixture" } } }),
    "lsp-server.mjs": "process.stdin.resume();\n",
    ".mcp.json": JSON.stringify({ mcpServers: { "fixture-api": { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs"], env: { TOKEN: "${PLUGIN_TEST_TOKEN}" } } } }),
    "mcp.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { "fixture-api": { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.mjs"], env: { TOKEN: "${PLUGIN_TEST_TOKEN}" } } } }),
    "server.mjs": `let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\\n");
    if (end < 0) break;
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === undefined) continue;
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "modeck-fixture", version: "1.0.0" } }
      : message.method === "tools/list" ? { tools: [] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`,
    "assets/prompt.txt": "fixture support asset\n",
    "scripts/support.sh": "#!/bin/sh\nprintf 'fixture support script\\n'\n",
  };
  if (!portable) delete files["plugin.json"];
  if (codexOnly) {
    delete files[".claude-plugin/plugin.json"];
    const manifestPath = files["plugin.json"] ? "plugin.json" : ".codex-plugin/plugin.json";
    const manifest = JSON.parse(files[manifestPath]);
    delete manifest.extensions;
    files[manifestPath] = JSON.stringify(manifest);
    for (const path of ["commands/check.md", "commands/SKILL.md", "agents/reviewer.md", "hooks/hooks.json", "hooks/write-marker.mjs", ".lsp.json", ".mcp.json"]) delete files[path];
  }
  if (claudeOnly) {
    delete files["plugin.json"];
    delete files[".codex-plugin/plugin.json"];
    delete files["mcp.json"];
  }
  for (const [path, contents] of Object.entries(files)) {
    const target = join(source, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
  await execFile("git", ["init", "--quiet", source]);
  await execFile("git", ["-C", source, "add", "-A"]);
  await execFile("git", ["-C", source, "-c", "user.name=Modeck Test", "-c", "user.email=modeck@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  const { stdout: commit } = await execFile("git", ["-C", source, "rev-parse", "HEAD"]);
  const yaml = `defaults: [base]\nmodes:\n  base: {}\n  selected:\n    extends: [base]\n    plugins: [fixture]\nplugins:\n  fixture:\n    source:\n      url: ./source\n      commit: ${commit.trim()}\nresources: {}\n`;
  await writeFile(join(config, "modeck.yaml"), yaml);
  return { root, config, source, cwd, home, state, commit: commit.trim(), yaml,
    configFile: join(config, "modeck.yaml"),
    async readLock() { return JSON.parse(await readFile(join(config, "modeck-plugins-lock.json"), "utf8")); } };
};

export const repinPluginFixture = async fixture => {
  await execFile("git", ["-C", fixture.source, "add", "-A"]);
  await execFile("git", ["-C", fixture.source, "-c", "user.name=Modeck Test", "-c", "user.email=modeck@example.invalid", "commit", "--quiet", "-m", "updated fixture"]);
  const { stdout } = await execFile("git", ["-C", fixture.source, "rev-parse", "HEAD"]);
  fixture.yaml = fixture.yaml.replace(fixture.commit, stdout.trim());
  fixture.commit = stdout.trim();
  await writeFile(fixture.configFile, fixture.yaml);
};

export const cliEnvironment = (fixture, agent) => {
  const env = { HOME: fixture.home, MODECK_STATE: fixture.state };
  for (const key of ["PATH", "TMPDIR", "TEMP", "LANG", "LC_ALL", "SystemRoot"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (agent === "claude") env.CLAUDE_CONFIG_DIR = join(fixture.home, ".claude");
  if (agent === "codex") env.CODEX_HOME = join(fixture.home, ".codex");
  if (fixture.nativePath) env.PATH = `${fixture.nativePath}:${env.PATH ?? ""}`;
  delete env.PLUGIN_TEST_TOKEN;
  return env;
};

export const invokeModeck = async (fixture, action, agent = "claude", extra = []) => {
  return execFile(process.execPath, [modeckBin, "plugin", action, "--config", fixture.config,
    "--target-home", fixture.home, "--cwd", fixture.cwd, "--agent", agent, "--format", "json", ...extra],
  { cwd: fixture.cwd, env: cliEnvironment(fixture, agent), timeout: 120_000, maxBuffer: 1_000_000 });
};

export const invokeModeckArgs = async (fixture, args, agent = "claude") => {
  return execFile(process.execPath, [modeckBin, ...args],
    { cwd: fixture.cwd, env: cliEnvironment(fixture, agent), timeout: 120_000, maxBuffer: 1_000_000 });
};

export const invokeNative = async (fixture, agent, args, { timeout = 120_000 } = {}) => {
  const { execFile: callback } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return promisify(callback)(agent, args, { cwd: fixture.cwd, env: cliEnvironment(fixture, agent), timeout, maxBuffer: 1_000_000 });
};

export const invokeCodexAppServer = async (fixture, requests) => {
  const child = spawn("codex", ["app-server"], {
    cwd: fixture.cwd, env: cliEnvironment(fixture, "codex"), stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && pending.has(message.id)) {
        const callbacks = pending.get(message.id);
        pending.delete(message.id);
        callbacks.resolve(message);
      } else if (message.method) notifications.push(message);
    }
  });
  child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-16_384); });
  child.once("error", error => {
    for (const [id, callbacks] of pending) {
      pending.delete(id);
      callbacks.resolve({ error: { message: error.message } });
    }
  });
  child.once("exit", code => {
    for (const [id, callbacks] of pending) {
      pending.delete(id);
      callbacks.resolve({ error: { message: `app-server exited (${code}): ${stderr}` } });
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex app-server ${method} timed out: ${stderr}`));
    }, 30_000);
    pending.set(id, {
      resolve: value => {
        clearTimeout(timeout);
        if (value.error) reject(new Error(`Codex app-server ${method} failed: ${JSON.stringify(value.error)}`));
        else resolve(value.result);
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    await request("initialize", { clientInfo: { name: "modeck-plugin-test", version: "1.0.0" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
    const results = {};
    for (const { name, method, params } of requests) results[name] = await request(method,
      typeof params === "function" ? await params(results) : params);
    results.notifications = notifications;
    return results;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timeout = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
        child.once("close", () => { clearTimeout(timeout); resolve(); });
        child.kill("SIGTERM");
      });
    }
  }
};
