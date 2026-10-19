const claudeSources = ["startup", "resume", "clear", "compact", "fork"] as const;
const qwenSources = ["startup", "resume", "clear", "compact"] as const;
const qoderSources = ["startup", "resume", "clear", "compact", "new"] as const;

export type AgentAdapter = {
  readonly executable: string;
  readonly rulesyncTarget: string;
  readonly configDirectory: string;
  readonly configEnvironment: string | null;
  readonly scanDirectories: readonly string[];
  readonly nativeSkills: boolean;
  // Native instruction files the agent loads on its own; a modeck rule whose body already
  // exists verbatim inside one of them is dropped from the injected context.
  readonly instructions: {
    readonly projectFiles: readonly string[];
    readonly userFile: string | null;
    readonly ancestors: boolean;
  } | null;
  readonly hook: {
    readonly file: string;
    readonly rulesyncFile?: string;
    readonly event: string;
    readonly canonicalEvent: string;
    readonly sources: readonly string[];
    readonly cwdFallback: boolean;
    readonly commandOptions: { readonly additionalContextLimit?: number };
    readonly nativeContainer: "hooks" | "events" | "versioned-hooks";
    readonly nativeEntries: "groups" | "command";
    readonly output: "hookSpecificOutput" | "additionalContext";
    readonly input: "standard" | "copilot";
    readonly matcher: boolean;
    readonly timeoutField: "timeout" | "timeoutSec";
  };
  readonly skills: {
    readonly projectDirectory: string;
    readonly ancestors: boolean;
    readonly sharedHome: string | null;
    readonly system: string | null;
    readonly requireMetadata: boolean;
    readonly recursive: boolean;
    readonly qualifiedFallback: boolean;
  } | null;
};

export const agentDefinitions = {
  claude: {
    scanDirectories: [".claude"],
    nativeSkills: true,
    executable: "claude", rulesyncTarget: "claudecode", configDirectory: ".claude", configEnvironment: "CLAUDE_CONFIG_DIR",
    hook: { file: ".claude/settings.json", event: "SessionStart", canonicalEvent: "sessionStart", sources: claudeSources,
      cwdFallback: false, commandOptions: {}, nativeContainer: "hooks", nativeEntries: "groups", output: "hookSpecificOutput",
      input: "standard", matcher: true, timeoutField: "timeout" },
    skills: { projectDirectory: ".claude/skills", ancestors: true, sharedHome: null, system: null,
      requireMetadata: false, recursive: false, qualifiedFallback: false },
    instructions: { projectFiles: ["CLAUDE.md", ".claude/CLAUDE.md"], userFile: "CLAUDE.md", ancestors: true },
  },
  codex: {
    scanDirectories: [".codex", ".agents"],
    nativeSkills: true,
    executable: "codex", rulesyncTarget: "codexcli", configDirectory: ".codex", configEnvironment: "CODEX_HOME",
    hook: { file: ".codex/hooks.json", event: "SessionStart", canonicalEvent: "sessionStart", sources: claudeSources, cwdFallback: false,
      commandOptions: { additionalContextLimit: 0 }, nativeContainer: "hooks", nativeEntries: "groups", output: "hookSpecificOutput",
      input: "standard", matcher: true, timeoutField: "timeout" },
    skills: { projectDirectory: ".agents/skills", ancestors: true, sharedHome: ".agents/skills", system: "/etc/codex/skills",
      requireMetadata: true, recursive: true, qualifiedFallback: false },
    instructions: { projectFiles: ["AGENTS.md"], userFile: "AGENTS.md", ancestors: true },
  },
  codebuddy: {
    scanDirectories: [".codebuddy", ".codebuddy-cli"],
    nativeSkills: true,
    executable: "codebuddy", rulesyncTarget: "codebuddy", configDirectory: ".codebuddy", configEnvironment: "CODEBUDDY_CONFIG_DIR",
    // CodeBuddy 2.168 runs the hook in the project but omits cwd in its input.
    hook: { file: ".codebuddy/settings.json", event: "SessionStart", canonicalEvent: "sessionStart", sources: claudeSources,
      cwdFallback: true, commandOptions: {}, nativeContainer: "hooks", nativeEntries: "groups", output: "hookSpecificOutput",
      input: "standard", matcher: true, timeoutField: "timeout" },
    skills: { projectDirectory: ".codebuddy/skills", ancestors: false, sharedHome: null, system: null,
      requireMetadata: false, recursive: true, qualifiedFallback: true },
    // Only the confirmed surfaces: project AGENTS.md and the global CODEBUDDY.md.
    instructions: { projectFiles: ["AGENTS.md"], userFile: "CODEBUDDY.md", ancestors: false },
  },
  qwen: {
    scanDirectories: [".qwen"],
    nativeSkills: false,
    executable: "qwen", rulesyncTarget: "qwencode", configDirectory: ".qwen", configEnvironment: "QWEN_HOME",
    hook: { file: ".qwen/settings.json", event: "SessionStart", canonicalEvent: "sessionStart", sources: qwenSources,
      cwdFallback: false, commandOptions: {}, nativeContainer: "hooks", nativeEntries: "groups", output: "hookSpecificOutput",
      input: "standard", matcher: true, timeoutField: "timeout" },
    skills: null,
    instructions: { projectFiles: ["QWEN.md", "AGENTS.md"], userFile: "QWEN.md", ancestors: true },
  },
  qoder: {
    scanDirectories: [".qoder"],
    nativeSkills: false,
    executable: "qodercli", rulesyncTarget: "qoder", configDirectory: ".qoder", configEnvironment: "QODER_CONFIG_DIR",
    hook: { file: ".qoder/settings.json", event: "SessionStart", canonicalEvent: "sessionStart", sources: qoderSources,
      cwdFallback: false, commandOptions: {}, nativeContainer: "hooks", nativeEntries: "groups", output: "hookSpecificOutput",
      input: "standard", matcher: true, timeoutField: "timeout" },
    skills: null,
    instructions: { projectFiles: ["AGENTS.md"], userFile: "AGENTS.md", ancestors: false },
  },
  copilot: {
    scanDirectories: [], executable: "copilot", rulesyncTarget: "copilotcli", configDirectory: ".copilot", configEnvironment: "COPILOT_HOME",
    nativeSkills: false, instructions: null,
    hook: { file: ".copilot/hooks/modeck.json", rulesyncFile: ".github/hooks/copilotcli-hooks.json", event: "sessionStart", canonicalEvent: "sessionStart",
      sources: ["startup", "resume", "new"], cwdFallback: false, commandOptions: {}, nativeContainer: "versioned-hooks",
      nativeEntries: "command", output: "additionalContext", input: "copilot", matcher: false, timeoutField: "timeoutSec" },
    skills: null,
  },
  droid: {
    scanDirectories: [], executable: "droid", rulesyncTarget: "factorydroid", configDirectory: ".factory", configEnvironment: null,
    nativeSkills: false, instructions: null,
    hook: { file: ".factory/hooks.json", event: "SessionStart", canonicalEvent: "sessionStart",
      sources: ["startup", "resume", "clear", "compact"], cwdFallback: false, commandOptions: {}, nativeContainer: "events",
      nativeEntries: "groups", output: "hookSpecificOutput", input: "standard", matcher: true, timeoutField: "timeout" },
    skills: null,
  },
} as const satisfies Readonly<Record<string, AgentAdapter>>;

export type AgentId = keyof typeof agentDefinitions;
export const agents = Object.freeze(Object.keys(agentDefinitions) as AgentId[]);
export const isAgent = (value: unknown): value is AgentId => typeof value === "string" && Object.hasOwn(agentDefinitions, value);
