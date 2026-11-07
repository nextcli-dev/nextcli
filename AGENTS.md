# AGENTS.md

Guidance for coding agents and people working in this repository. `cn` (and so the AI review checks) and the VS Code extension load this file into every session, so keep it short. [MAINTAINING.md](./MAINTAINING.md) covers releases, CI and the identifiers that stay unchanged.

## What NextCLI is for

NextCLI is a community continuation of [Continue](https://github.com/continuedev/continue): the `cn` CLI (`extensions/cli`, package `@nextcli/cli`) and the VS Code extension (`extensions/vscode`, id `nextcli.nextcli`).

The CLI is the priority. Its main job is to review pull requests and fix bugs on them, unattended, in other people's CI, through the [nextcli-checks](https://github.com/nextcli-dev/nextcli-checks) GitHub Action. Judge changes against that goal:

- **Safe on untrusted input.** A pull request under review is untrusted. A review job must not run arbitrary commands, leak secrets, or change files when it only reviews.
- **Small and auditable.** One person should be able to read the agent loop and explain what runs on a client's code. Prefer deleting code to adding it.
- **Predictable cost.** Hard caps on turns, tokens and dollars (`--max-turns`, `--max-session-tokens`, `--max-cost`) must keep working. An unknown price is never treated as zero.
- **Local and private.** No hosted service, sign-in or telemetry endpoint.

Not goals: a server mode, chat-app integrations, a web console, long-term memory, embeddings or a vector store, container backends. Don't add them unless an issue asks for them.

## Repository layout

| Path                  | What it is                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/cli/`     | The `cn` CLI: Ink terminal UI, headless mode (`-p`), `cn review`, tools, permissions, hooks, MCP. Has its own AGENTS.md.                                          |
| `extensions/vscode/`  | VS Code extension. It embeds `core` directly and doesn't use the CLI.                                                                                             |
| `core/`               | Shared IDE engine (config, LLM classes, tools, indexing). The CLI still imports parts of it.                                                                      |
| `gui/`                | React webview for the extension                                                                                                                                   |
| `packages/`           | Libraries used through their `dist`: `config-yaml`, `config-types`, `openai-adapters`, `llm-info`, `fetch`, and `terminal-security` (the shell-command evaluator) |
| `.checks/`            | AI review checks that `.github/workflows/ai-checks.yml` runs on this repository                                                                                   |
| `.continue/`          | Rules, prompts and checks inherited from Continue. Some are stale; this file wins on conflict.                                                                    |
| `docs/`, `docs-site/` | User docs for docs.nextcli.dev                                                                                                                                    |
| `scripts/ci/`         | CI area selection (`affected.mjs`) and the deprecated-dependency check                                                                                            |

Dependencies flow `packages/*` → `core` → `gui`, `extensions/vscode`, `extensions/cli`.

## Current work, in order

1. **Safety of unattended runs.** Headless mode still allows `Bash` and every MCP tool by default (`extensions/cli/src/permissions/defaultPolicies.ts`). The target: unknown and MCP tools are excluded, `Bash` only runs commands that `packages/terminal-security` allows, any `ask` with nobody present is denied, and the shell gets no secret-like environment variables.
2. **Dependencies and the AI-SDK migration.** Deprecated packages are tracked in `scripts/ci/deprecations-allowlist.json`. Remove an entry in the same change that fixes it.
3. **Continue leftovers in the CLI.** Delete WorkOS auth, the hub and platform clients, remote sessions, `ArtifactUploadService` and the `Continue-CLI` user agent once nothing uses them. For each `CONTINUE_*` environment variable, add a `NEXTCLI_*` name and keep reading the old one as a fallback.
4. **Separating the CLI from `core`.** Don't add new `core/*` imports to `extensions/cli`. Move shared types into a small package instead.

## Rules

- **Keep these identifiers** unless the change is an explicit, migrated compatibility break: the `cn` command, `~/.continue`, `.continue/`, `.continueignore` and the remaining `@continuedev/*` package names.
- **No telemetry by default.** Don't add a default endpoint, analytics key or Sentry DSN. Keep the `@opentelemetry/*` dependencies in the CLI; upgrade them, don't remove them.
- **Don't rename the publish workflows** (`publish-vscode.yaml`, `release-cli.yml`). Open VSX, the Marketplace and npm trusted publishing are bound to those file names.
- **New tools and permissions:** a new built-in tool needs an explicit default policy for interactive, headless and `--readonly` runs. When unsure, make the headless default `exclude`.
- **Supported runtimes:** Node 22.15 or later for the CLI (`.nvmrc` pins the dev version), VS Code 1.103 or later for the extension.
- **`node:sqlite`** (used in `core/`) needs Node 22.16 or later for FTS5, has foreign keys on by default, and blocks the event loop on large synchronous queries.
- **Relative imports in the CLI need the `.js` extension** (`from "./foo.js"`).
- **Tests:** add or update a test for each behavior change and run it. A test that only checks wording or source text doesn't cover behavior. In `core/`, `*.test.ts` runs under Jest and `*.vitest.ts` under Vitest; write new tests as `*.vitest.ts`.

## Reviewing changes

These rules apply to agents reviewing pull requests here, including the checks in `.checks/`:

- Mark a finding **critical** only if you can name the exact file, symbol or config that is broken now, it is in the diff or its context, it needs a change to this diff, and you can say what triggers it in real use. Otherwise it is advisory.
- One root cause is one finding. Don't split it, and don't rephrase a fixed finding as a broader future risk.
- No findings is a valid result. Don't invent findings to fill a list.
- A change that adds or tightens a guard, filter or deny rule needs a test that walks a legitimate flow through the new guard. A test that only shows it blocks something is not enough.
- Check for forgotten touchpoints: callers, tests, docs and configs that describe or depend on the changed behavior.

## Before you finish: run the CI checks locally

After a change and before reporting it done or committing, run what CI (`.github/workflows/ci.yml`) runs for every area you touched. Report failures verbatim; don't call work done while one fails.

See which areas CI will check for your branch, and why:

```bash
node scripts/ci/affected.mjs --base origin/main --explain
```

**Build first.** The CLI typechecks and tests against `core/dist` and each package's `dist`. After changing `core/` or a package, run `npm run build` there (`node scripts/build-packages.js` builds every package in order), or the checks run against stale code.

**Formatting**, always, from the repo root. CI checks the files a pull request changes, or every file on a full run:

```bash
npx prettier --write <files you changed>
{ git diff --name-only --diff-filter=d --merge-base origin/main; git ls-files --others --exclude-standard; } \
  | grep -E '\.(js|jsx|ts|tsx|json|css|md)$' \
  | xargs -r npx prettier --check --ignore-path .gitignore --ignore-path .prettierignore --no-error-on-unmatched-pattern
```

**Per area**, in that directory:

| Area                                                             | Commands                                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `core/`                                                          | `npx tsc --noEmit && npm run lint && npm test && npm run vitest`                       |
| `gui/`                                                           | `npx tsc --noEmit && npm run lint && npm test`                                         |
| `extensions/vscode/`                                             | `npm run write-build-timestamp && npx tsc --noEmit && npm run lint && npm run vitest`  |
| `extensions/cli/`                                                | `npm run lint && npm run build && npm run test:smoke && npm test && npm run test:e2e`  |
| `packages/<name>/`                                               | `npm test && npm run build`                                                            |
| Any `package.json` or lockfile, or `scripts/ci/` (from the root) | `node scripts/ci/check-deprecations.mjs --strict && node --test scripts/ci/*.test.mjs` |

For a narrow change, run the affected test files first, then the area's full commands before finishing.

## Git and pull requests

- Pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/) (`fix(cli): ...`, `feat(vscode): ...`). release-please builds versions and changelogs from the squash commit, which uses the title.
- Use `.github/pull_request_template.md` for the PR body. Leave the Contributing Guide and CLA checkboxes for the human author.
- Don't merge `main` into a PR branch. Rebase instead, and leave force-pushing to the human.
- Don't commit or push unless asked.
