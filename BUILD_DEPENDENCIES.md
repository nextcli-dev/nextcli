# Build Dependencies & Secrets

Secrets, variables and environments used by the workflows in `.github/workflows/`. Workflows parked in `.github/workflows-archive/` are not included; its README lists what each of them needs.

## Secrets

| Secret                                                                                       | Set | Purpose                                                                                                                                                                     | Used in                                            |
| -------------------------------------------------------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `NEXTCLI_APP_PRIVATE_KEY`                                                                    | yes | Private key of the NextCLI Automation GitHub App. Release PRs and releases are created with its token so they start other workflows; `@vscode/ripgrep` uses it to download. | `ci.yml`, `release-prs.yml`, `publish-vscode.yaml` |
| `OPENAI_API_KEY`                                                                             | yes | Model API tests in `core/` and `packages/`, which run only when LLM-related files change.                                                                                   | `ci.yml`                                           |
| `ANTHROPIC_API_KEY`                                                                          | yes | Model API tests and CLI smoke API tests.                                                                                                                                    | `ci.yml`                                           |
| `PROVIDER_API_KEY`                                                                           | yes | Model provider key for AI checks.                                                                                                                                           | `ai-checks.yml`                                    |
| `NPM_TOKEN`                                                                                  | yes | Optional. If set, `release-cli.yml` publishes with it instead of npm trusted publishing (OIDC). Leave it unset once trusted publishing works.                               | `release-cli.yml`                                  |
| `SEMANTIC_RELEASE_NPM_TOKEN`                                                                 | yes | Unused. It published the `@nextcli/*` libraries, whose release workflows were removed. Delete it unless library releases come back.                                         | none                                               |
| `GROK_API_KEY`                                                                               | yes | Unused by workflows.                                                                                                                                                        | none                                               |
| `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `VOYAGE_API_KEY`, `RELACE_API_KEY`, `INCEPTION_API_KEY` | no  | Model API tests for those providers. Tests that need a missing key are skipped.                                                                                             | `ci.yml`                                           |
| `NEXTCLI_API_KEY`                                                                            | no  | CLI smoke API tests against a NextCLI-compatible API.                                                                                                                       | `ci.yml`                                           |
| `GH_ACTIONS_SSH_TEST_KEY_PEM`, `GH_ACTIONS_SSH_TEST_DNS_NAME`                                | no  | Remote SSH e2e tests. The SSH test (`extensions/vscode/e2e/tests/SSH.skip.ts`) is currently disabled, so these are only needed if it is turned back on.                     | `ci.yml`                                           |

Open VSX, the Visual Studio Marketplace and npm use trusted publishing (OIDC), so no registry token is stored. See [MAINTAINING.md](./MAINTAINING.md#releasing) for the trusted-publisher registrations.

## Variables

| Variable                                                             | Purpose                                                          | Used in                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| `NEXTCLI_APP_CLIENT_ID`                                              | Client ID of the NextCLI Automation GitHub App                   | `ci.yml`, `release-prs.yml`, `publish-vscode.yaml` |
| `CHECKS_PROVIDER`, `CHECKS_MODEL`, `CHECKS_BASE_URL`, `CHECKS_AGENT` | Model provider, model, optional base URL and agent for AI checks | `ai-checks.yml`                                    |

## Environments

| Environment  | Protection                                            | Used by                                                                         |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `production` | Required reviewer; only `vscode-v*` and `cli-v*` tags | Stable VS Code publish (`publish-vscode.yaml`), npm publish (`release-cli.yml`) |
| `staging`    | Only `main`                                           | VS Code pre-release publish (`publish-vscode.yaml`)                             |

The Marketplace trusted publishers are bound to these environment names.

## CLI environment

| Variable           | Purpose                                                                                          | Referenced in                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `NEXTCLI_API_BASE` | Optional base URL for a compatible API. Empty by default. NextCLI does not call api.nextcli.dev. | `extensions/cli/.env.example`                                                  |
| `NEXTCLI_API_KEY`  | API key for that API                                                                             | `extensions/cli/.env.example`, `packages/continue-sdk/typescript/.env.example` |
