const sessionSources = ["startup", "resume", "clear", "compact", "fork"] as const;

export type AgentAdapter = {
  readonly executable: string;
  readonly rulesyncTarget: string;
  readonly configDirectory: string;
  readonly configEnvironment: string;
  readonly scanDirectories: readonly string[];
  readonly run: {
    readonly flags: Readonly<Record<string, 0 | 1>>;
    readonly commands: readonly string[];
    readonly exec: boolean;
    readonly instructionChannel: "codex-config" | "system-append";
  };
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
    run: { flags: { "-p": 0, "--print": 0, "--model": 1, "--effort": 1, "--permission-mode": 1,
    "--output-format": 1, "--input-format": 1, "--max-budget-usd": 1, "--verbose": 0,
    "--no-session-persistence": 0, "--append-system-prompt": 1, "--append-system-prompt-file": 1 },
      commands: ["agents", "attach", "auth", "auto-mode", "doctor", "gateway", "import", "install", "logs", "mcp", "plugin", "plugins",
    "purge", "respawn", "rm", "setup-token", "stop", "kill", "ultrareview", "update", "upgrade", "help"],
      exec: false, instructionChannel: "system-append" },
    executable: "claude", rulesyncTarget: "claudecode", configDirectory: ".claude", configEnvironment: "CLAUDE_CONFIG_DIR",
    hook: { file: ".claude/settings.json", event: "SessionStart", canonicalEvent: "sessionStart", sources: sessionSources,
      cwdFallback: false, commandOptions: {} },
    skills: { projectDirectory: ".claude/skills", ancestors: true, sharedHome: null, system: null,
      requireMetadata: false, recursive: false, qualifiedFallback: false },
  },
  codex: {
    scanDirectories: [".codex", ".agents"],
    run: { flags: { "-m": 1, "--model": 1, "-s": 1, "--sandbox": 1, "-a": 1, "--ask-for-approval": 1,
    "--search": 0, "--no-alt-screen": 0, "--no-daemon": 0, "-c": 1, "--config": 1, "-C": 1, "--cd": 1 },
      commands: ["agents", "review", "login", "logout", "mcp", "plugin", "app-server", "remote-control", "app", "completion", "update",
    "doctor", "sandbox", "debug", "apply", "a", "resume", "queue", "archive", "delete", "migrate-rollouts", "unarchive", "fork",
    "cloud", "exec-server", "features", "help"],
      exec: true, instructionChannel: "codex-config" },
    executable: "codex", rulesyncTarget: "codexcli", configDirectory: ".codex", configEnvironment: "CODEX_HOME",
    hook: { file: ".codex/hooks.json", event: "SessionStart", canonicalEvent: "sessionStart", sources: sessionSources, cwdFallback: false,
      commandOptions: { additionalContextLimit: 0 } },
    skills: { projectDirectory: ".agents/skills", ancestors: true, sharedHome: ".agents/skills", system: "/etc/codex/skills",
      requireMetadata: true, recursive: true, qualifiedFallback: false },
  },
  codebuddy: {
    scanDirectories: [".codebuddy", ".codebuddy-cli"],
    run: { flags: { "-p": 0, "--print": 0, "--model": 1, "--effort": 1, "--permission-mode": 1,
    "--output-format": 1, "--input-format": 1, "--max-turns": 1, "--verbose": 0,
    "--no-session-persistence": 0, "--append-system-prompt": 1 },
      commands: ["config", "mcp", "sandbox", "plugin", "project", "doctor", "update", "install", "cleanup",
    "daemon", "ps", "logs", "attach", "kill", "stop", "rm", "respawn", "agents", "auto-mode", "help"],
      exec: false, instructionChannel: "system-append" },
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
