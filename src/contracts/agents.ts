const sessionSources = ["startup", "resume", "clear", "compact", "fork"] as const;

export type AgentAdapter = {
  readonly executable: string;
  readonly rulesyncTarget: string;
  readonly configDirectory: string;
  readonly configEnvironment: string;
  readonly scanDirectories: readonly string[];
  readonly hook: {
    readonly file: string;
    readonly event: "SessionStart";
    readonly canonicalEvent: "sessionStart";
    readonly sources: readonly typeof sessionSources[number][];
    readonly cwdFallback: boolean;
    readonly commandOptions: { readonly additionalContextLimit?: number };
  };
  readonly skills: {
    readonly projectDirectory: string;
    readonly ancestors: boolean;
    readonly sharedHome: string | null;
    readonly system: string | null;
    readonly requireMetadata: boolean;
    readonly recursive: boolean;
    readonly qualifiedFallback: boolean;
  };
};

export const agentDefinitions = {
  claude: {
    scanDirectories: [".claude"],
    executable: "claude", rulesyncTarget: "claudecode", configDirectory: ".claude", configEnvironment: "CLAUDE_CONFIG_DIR",
    hook: { file: ".claude/settings.json", event: "SessionStart", canonicalEvent: "sessionStart", sources: sessionSources,
      cwdFallback: false, commandOptions: {} },
    skills: { projectDirectory: ".claude/skills", ancestors: true, sharedHome: null, system: null,
      requireMetadata: false, recursive: false, qualifiedFallback: false },
  },
  codex: {
    scanDirectories: [".codex", ".agents"],
    executable: "codex", rulesyncTarget: "codexcli", configDirectory: ".codex", configEnvironment: "CODEX_HOME",
    hook: { file: ".codex/hooks.json", event: "SessionStart", canonicalEvent: "sessionStart", sources: sessionSources, cwdFallback: false,
      commandOptions: { additionalContextLimit: 0 } },
    skills: { projectDirectory: ".agents/skills", ancestors: true, sharedHome: ".agents/skills", system: "/etc/codex/skills",
      requireMetadata: true, recursive: true, qualifiedFallback: false },
  },
  codebuddy: {
    scanDirectories: [".codebuddy", ".codebuddy-cli"],
    executable: "codebuddy", rulesyncTarget: "codebuddy", configDirectory: ".codebuddy", configEnvironment: "CODEBUDDY_CONFIG_DIR",
    // CodeBuddy 2.168 runs the hook in the project but omits cwd in its input.
    hook: { file: ".codebuddy/settings.json", event: "SessionStart", canonicalEvent: "sessionStart", sources: sessionSources,
      cwdFallback: true, commandOptions: {} },
    skills: { projectDirectory: ".codebuddy/skills", ancestors: false, sharedHome: null, system: null,
      requireMetadata: false, recursive: true, qualifiedFallback: true },
  },
} as const satisfies Readonly<Record<string, AgentAdapter>>;

export type AgentId = keyof typeof agentDefinitions;
export const agents = Object.freeze(Object.keys(agentDefinitions) as AgentId[]);
export const isAgent = (value: unknown): value is AgentId => typeof value === "string" && Object.hasOwn(agentDefinitions, value);
