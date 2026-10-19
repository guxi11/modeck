export const SCHEMA_VERSION = 1 as const;
export const PROTOCOL = "modeck-context/1" as const;

export const LIMITS = Object.freeze({
  jsonBytes: 1_048_576,
  manifestBytes: 8_388_608,
  modes: 256,
  resources: 512,
  idLength: 64,
  pathLength: 1024,
  urlLength: 2048,
  refLength: 256,
  scanEntries: 20_000,
  scanFiles: 10_000,
  scanDepth: 64,
  treeEntries: 10_000,
  treeBytes: 67_108_864,
  fileBytes: 16_777_216,
  textFileBytes: 1_048_576,
  allResourceBytes: 536_870_912,
  skillDescriptionChars: 1024,
  // Defensive ceiling for agents whose platform imposes no known cap on injected
  // context: stops a pathological multi-Megabyte payload from breaking hook
  // pipelines that were never sized for it. Not a platform value; an agent with
  // a verified platform cap overrides it via AgentAdapter.contextLimit.
  contextSafetyValveChars: 1_000_000,
  contextDescriptionChars: 200,
  hookTimeoutSeconds: 15,
  hookInputBytes: 1_048_576,
  sessionIdChars: 256,
  gitTimeoutMs: 120_000,
  probeTimeoutMs: 10_000,
});
