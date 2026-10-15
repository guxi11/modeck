---
name: agent-modes
description: Manage agent-modes configuration, mode selection, locked rules and complete skill resources, and agent integration when asked to maintain or explain those settings.
---

Use the `agent-modes` CLI rather than generating project AGENTS.md or CLAUDE.md.

Locate the configuration using `--config`, then `AGENT_MODES_CONFIG`, then `$HOME/.config/agent-modes`. `init --dir` creates a new configuration repository; `import --from --dir` imports one. Edit its `modes.json` and resources; use the nearest project `.mode` only to select modes or disable inference.

Run `resolve --cwd` to explain selected modes and their reasons. Run `render --agent codex|claude --cwd` to inspect the exact context. Rules load immediately; indexed skills have usable `root` and `entry` paths. Resolve relative skill references from that root, read its SKILL.md before use, and execute scripts only when the task calls for them.

Use `sync` to create or reuse a resource lock, `sync --frozen` to reproduce it, and `sync --update` only for an intended version update. Missing or changed resources must be reconciled explicitly; render/hook/run stay offline and never update the lock.

Preview `install` or `uninstall` with explicit `--agent` and `--target-home` before applying the user's intended change with `--apply`; `--expect` can guard a reviewed plan. The target is a HOME root: Codex hooks live in `.codex` and this skill in `.agents/skills`; Claude uses `.claude`. Preserve other tools' settings and stop on ownership or evoloop conflicts.

SessionStart hooks or `run --agent ... -- ...` wrappers supply startup context. This skill alone does not guarantee execution before the first model request. Codex requires review and trust of installed hooks in `/hooks`; installation does not grant trust. Context digests describe bytes and do not prove provider cache hits.
