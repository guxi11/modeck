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
  },
  qwen: {
    scanDirectories: [".qwen"],
    nativeSkills: false,
    executable: "qwen", rulesyncTarget: "qwencode", configDirectory: ".qwen", configEnvironment: null,
    hook: { file: ".qwen/settings.json", event: "SessionStart", canonicalEvent: "sessionStart", sources: qwenSources,
      cwdFallback: false, commandOptions: {}, nativeContainer: "hooks", nativeEntries: "groups", output: "hookSpecificOutput",
      input: "standard", matcher: true, timeoutField: "timeout" },
    skills: null,
  },
  qoder: {
    scanDirectories: [".qoder"],
    nativeSkills: false,
    executable: "qodercli", rulesyncTarget: "qoder", configDirectory: ".qoder", configEnvironment: "QODER_CONFIG_DIR",
    hook: { file: ".qoder/settings.json", event: "SessionStart", canonicalEvent: "sessionStart", sources: qoderSources,
      cwdFallback: false, commandOptions: {}, nativeContainer: "hooks", nativeEntries: "groups", output: "hookSpecificOutput",
      input: "standard", matcher: true, timeoutField: "timeout" },
    skills: null,
  },
  copilot: {
    scanDirectories: [], executable: "copilot", rulesyncTarget: "copilotcli", configDirectory: ".copilot", configEnvironment: "COPILOT_HOME",
    nativeSkills: false,
    hook: { file: ".copilot/hooks/modeck.json", rulesyncFile: ".github/hooks/copilotcli-hooks.json", event: "sessionStart", canonicalEvent: "sessionStart",
      sources: ["startup", "resume", "new"], cwdFallback: false, commandOptions: {}, nativeContainer: "versioned-hooks",
      nativeEntries: "command", output: "additionalContext", input: "copilot", matcher: false, timeoutField: "timeoutSec" },
    skills: null,
  },
  droid: {
    scanDirectories: [], executable: "droid", rulesyncTarget: "factorydroid", configDirectory: ".factory", configEnvironment: null,
    nativeSkills: false,
    hook: { file: ".factory/hooks.json", event: "SessionStart", canonicalEvent: "sessionStart",
      sources: ["startup", "resume", "clear", "compact"], cwdFallback: false, commandOptions: {}, nativeContainer: "events",
      nativeEntries: "groups", output: "hookSpecificOutput", input: "standard", matcher: true, timeoutField: "timeout" },
    skills: null,
  },
} as const satisfies Readonly<Record<string, AgentAdapter>>;

export type AgentId = keyof typeof agentDefinitions;
export const agents = Object.freeze(Object.keys(agentDefinitions) as AgentId[]);
export const isAgent = (value: unknown): value is AgentId => typeof value === "string" && Object.hasOwn(agentDefinitions, value);
