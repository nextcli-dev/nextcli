# Build Dependencies & Secrets

This document catalogs all build dependencies, secrets, and environment variables required by the continue-fork repository.

---

## VS Code Extension

Open VSX publishing does not use a secret. `publish-vscode.yaml` publishes with trusted publishing: pre-releases (odd minor) from the `publish-preview` job in the GitHub environment `staging`, and stable releases (even minor) from the `publish-stable` job in the GitHub environment `production`. Both environments must exist on `nextcli-dev/nextcli` with those exact names. Open VSX allows one trusted publisher per extension, so the registration for `nextcli.nextcli` names `publish-vscode.yaml` and leaves the environment blank.

---

## CLI

| Variable           | Purpose                                                                                          | Referenced In                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `NEXTCLI_API_BASE` | Optional base URL for a compatible API. Empty by default. NextCLI does not call api.nextcli.dev. | `extensions/cli/.env.example`                                                                      |
| `NEXTCLI_API_KEY`  | API key for NextCLI authentication                                                               | `extensions/cli/.env.example`, `packages/continue-sdk/typescript/.env.example`, multiple workflows |

---

## NPM Package Releases

| Secret                       | Purpose                                                                                                                                                                                                                     | Referenced In                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `SEMANTIC_RELEASE_NPM_TOKEN` | npm token used to publish `@nextcli/fetch`, `@nextcli/config-yaml`, `@nextcli/llm-info`, and `@nextcli/openai-adapters`. The workflow computes the version from the latest npm release plus a patch, minor, or major input. | `release-openai-adapters.yml`, `release-config-yaml.yml`, `release-fetch.yml`, `release-llm-info.yml`, `reusable-release.yml` |
| `NPM_TOKEN`                  | Short-lived npm token used only to bootstrap `@nextcli/cli`. Delete it after trusted publishing is configured for `release-cli.yml`.                                                                                        | `release-cli.yml`                                                                                                             |

---

## AI Provider API Keys (Testing & Releases)

Used for integration tests in PR checks and package releases.

| Secret              | Purpose                      | Referenced In                                                                                         |
| ------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`    | OpenAI API key               | `pr-checks.yaml`, `reusable-release.yml`, `release-*.yml`                                             |
| `ANTHROPIC_API_KEY` | Anthropic API key            | `pr-checks.yaml`, `reusable-release.yml`, `release-*.yml`, `cli-pr-checks.yml`, `continue-agents.yml` |
| `GEMINI_API_KEY`    | Google Gemini API key        | `pr-checks.yaml`, `reusable-release.yml`, `release-*.yml`                                             |
| `MISTRAL_API_KEY`   | Mistral API key              | `pr-checks.yaml`, `reusable-release.yml`, `release-*.yml`                                             |
| `VOYAGE_API_KEY`    | Voyage AI embeddings API key | `pr-checks.yaml`, `reusable-release.yml`, `release-*.yml`                                             |
| `RELACE_API_KEY`    | Relace API key               | `pr-checks.yaml`, `reusable-release.yml`, `release-*.yml`                                             |
| `INCEPTION_API_KEY` | Inception API key            | `pr-checks.yaml`, `reusable-release.yml`, `release-*.yml`                                             |

---

## CI/CD & GitHub

| Secret                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                      | Referenced In                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`            | Default GitHub Actions token (automatic). Attaches VSIX files to releases and assigns issues.                                                                                                                                                                                                                                                                                                                | Many workflows, including `publish-vscode.yaml` and `auto-assign-issue.yaml`                                          |
| `NEXTCLI_APP_PRIVATE_KEY` | Private key of the NextCLI Automation GitHub App. Jobs mint a one-hour installation token with `actions/create-github-app-token`. The pre-release version-bump pull request uses a token for the current repository. Extension `npm ci` uses an installation-wide token so `@vscode/ripgrep` can read public release assets. The client ID is the repository variable `NEXTCLI_APP_CLIENT_ID`, not a secret. | `publish-vscode.yaml`, `pr-checks.yaml`, `pr-build-upload-vsix.yaml`                                                  |
| `NEXTCLI_API_KEY`         | NextCLI platform API key for agent workflows                                                                                                                                                                                                                                                                                                                                                                 | `run-continue-agent.yml`, `tidy-up-codebase.yml`, `snyk-agent.yaml`, `auto-fix-failed-tests.yml`, `cli-pr-checks.yml` |
| `RUNLOOP_API_KEY`         | Runloop API key for uploading sandbox blueprints                                                                                                                                                                                                                                                                                                                                                             | `upload-runloop-blueprint.yml`                                                                                        |
| `SNYK_TOKEN`              | Snyk security scanning token                                                                                                                                                                                                                                                                                                                                                                                 | `snyk-agent.yaml`                                                                                                     |

---

## Issue/PR Tooling

| Secret                               | Purpose                                              | Referenced In        |
| ------------------------------------ | ---------------------------------------------------- | -------------------- |
| `CHROMA_CLOUD_API_KEY`               | Chroma vector DB API key for similar issue detection | `similar-issues.yml` |
| `CHROMA_TENANT`                      | Chroma tenant identifier                             | `similar-issues.yml` |
| `CHROMA_DATABASE`                    | Chroma database name                                 | `similar-issues.yml` |
| `ISSUE_PR_METRICS_SLACK_WEBHOOK_URL` | Slack webhook for PR/issue metrics notifications     | `metrics.yaml`       |

---

## SSH Testing

| Secret                         | Purpose                                     | Referenced In    |
| ------------------------------ | ------------------------------------------- | ---------------- |
| `GH_ACTIONS_SSH_TEST_KEY_PEM`  | SSH private key for remote connection tests | `pr-checks.yaml` |
| `GH_ACTIONS_SSH_TEST_DNS_NAME` | DNS name of the SSH test host               | `pr-checks.yaml` |

---

All workflow files are located under `.github/workflows/`. Environment example files are at:

- `extensions/cli/.env.example`
- `packages/continue-sdk/typescript/.env.example`
