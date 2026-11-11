# AGENTS.md: extensions/cli

The `cn` CLI. Read the [root AGENTS.md](../../AGENTS.md) first for goals, rules and the CI checks. This file covers only the CLI.

## Where things are

- `src/projectEnv.ts` and `src/workspaceTrust.ts`: called from the `preAction` hook in `src/index.ts`, once the command is known. They decide whether the working directory is trusted and load the project's `.env` files only from a trusted folder; `~/.continue/.env` loads in every folder.
- `src/index.ts`: entry point and commands. `-p/--print` runs headless. With no flag it starts the Ink TUI (`src/ui/`).
- `src/commands/`: `chat`, `review` (and `review/`), `checks`, `ls`, `cleanup`. Shared flags are in `BaseCommandOptions.ts` and `src/shared-options.ts`.
- `src/stream/`: the agent loop (`streamChatResponse.ts`, `handleToolCalls.ts`) and the turn, token and cost limits (`agentLoopLimits.ts`).
- `src/tools/`: built-in tools. A new tool goes in `builtInToolNames.ts`, `allBuiltIns.ts` and `src/permissions/defaultPolicies.ts`.
- `src/permissions/`: tool policies, with defaults and `--readonly` (plan mode) in `defaultPolicies.ts`.
- `src/services/`: config, models, MCP, permissions and the rest, wired through `ServiceContainer.ts`.
- `src/systemMessage.ts`: builds the system prompt. It loads the first of `AGENTS.md`, `AGENT.md`, `CLAUDE.md` or `CODEX.md` from the working directory.

## Hooks (`src/hooks/`)

Claude Code-compatible.

- Config, lowest to highest precedence: `~/.claude/settings.json`, `~/.continue/settings.json`, `.claude/settings.json`, `.continue/settings.json`, `.claude/settings.local.json`, `.continue/settings.local.json`.
- Exit codes: 0 proceeds, 2 blocks (stderr goes back to the model), anything else is a non-blocking error.
- `command` and `http` handlers run. `prompt` and `agent` handlers are skipped.

## Build and test

Build core first (`cd ../../core && npm run build`). Then, here:

- `npm run lint`: `tsc --noEmit` and eslint
- `npm run build`: validates and bundles into `dist/`
- `npm test`: Vitest unit tests. Use `npm test -- <path or pattern>` for some of them.
- `npm run test:smoke` and `npm run test:e2e`: run against `dist/`, so build first
- `node dist/index.js`: run the built CLI
