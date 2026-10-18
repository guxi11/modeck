import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentDefinitions, canonical, LIMITS, modeError } from "../contracts/index.js";
import type { Agent } from "../contracts/index.js";
import { imageJson, object, readImage } from "./fs.js";
import { hookGroup, readHookGroups } from "./hooks.js";

export const convertHookGroup = async (agent: Agent, expected: ReturnType<typeof hookGroup>): Promise<ReturnType<typeof hookGroup>> => {
  const adapter = agentDefinitions[agent];
  const temporary = await mkdtemp(join(await realpath(tmpdir()), "modeck-format-"));
  try {
    const source = join(temporary, ".rulesync");
    const output = join(temporary, "output");
    const configPath = join(temporary, "rulesync.json");
    await mkdir(source);
    await mkdir(output);
    // An explicit empty config prevents loading rulesync.jsonc from business cwd.
    await writeFile(configPath, "{}", { mode: 0o600 });
    const group = "matcher" in expected ? expected.matcher : undefined;
    await writeFile(join(source, "hooks.json"), canonical({
      hooks: { [adapter.hook.canonicalEvent]: expected.hooks.map(handler => ({ ...handler, ...(group === undefined ? {} : { matcher: group }) })) },
    }), { mode: 0o600 });
    // Read Rulesync's target path, then validate before writing to the adapter's user path.
    // Never enable global mode: Rulesync would then resolve the real user home.
    const { generate } = await import("rulesync");
    // 36.0.2 anchors configPath to inputRoot; inputRoots alone anchors it to cwd.
    const result = await generate({ configPath: "rulesync.json", inputRoot: temporary, outputRoots: [output],
      targets: [adapter.rulesyncTarget], features: ["hooks"], global: false,
      delete: false, dryRun: false, check: false, silent: true });
    if (result.sourceLoadFailedFeatures.length) {
      throw modeError("E_CONFIG", "Rulesync did not generate the requested hook", { agent });
    }
    const outputFile = "rulesyncFile" in adapter.hook ? adapter.hook.rulesyncFile ?? adapter.hook.file : adapter.hook.file;
    const image = await readImage(join(output, outputFile), LIMITS.jsonBytes);
    const root = image ? object(imageJson(image)) : {};
    const groups = readHookGroups(root, agent);
    // Fail closed if an upstream conversion drops any runtime-critical field.
    if (groups.length !== 1 || canonical(groups[0]) !== canonical(expected)) {
      throw modeError("E_CONFIG", "Rulesync changed the required hook protocol", { agent });
    }
    return groups[0] as ReturnType<typeof hookGroup>;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};
