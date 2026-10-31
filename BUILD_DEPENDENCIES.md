# Build Dependencies & Secrets

This document catalogs all build dependencies, secrets, and environment variables required by the continue-fork repository.

---

## VS Code Extension

Open VSX publishing does not use a secret. `main.yaml` publishes with trusted publishing in the GitHub environment `production`. `preview.yaml` publishes pre-releases with trusted publishing in the GitHub environment `staging`. Both environments must exist on `nextcli-dev/nextcli` with those exact names.

---

## CLI

| Variable            | Purpose                                                                                           | Referenced In                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `NEXTCLI_API_BASE` | Optional base URL for a compatible API. Empty by default. NextCLI does not call api.nextcli.dev. | `extensions/cli/.env.example`                                                                      |
| `NEXTCLI_API_KEY`  | API key for NextCLI authentication                                                                | `extensions/cli/.env.example`, `packages/continue-sdk/typescript/.env.example`, multiple workflows |

---

## NPM Package Releases

| Secret                          | Purpose                                                     | Referenced In                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `SEMANTIC_RELEASE_GITHUB_TOKEN` | GitHub token used by semantic-release for creating releases | `release-openai-adapters.yml`, `release-config-yaml.yml`, `release-fetch.yml`, `release-llm-info.yml`, `reusable-release.yml` |
| `SEMANTIC_RELEASE_NPM_TOKEN`    | npm token used by semantic-release for publishing packages  | `release-openai-adapters.yml`, `release-config-yaml.yml`, `release-fetch.yml`, `release-llm-info.yml`, `reusable-release.yml` |
| `NPM_TOKEN`                     | Short-lived npm token used only to bootstrap `@nextcli/cli`. Delete it after trusted publishing is configured for `release-cli.yml`. | `release-cli.yml`                                                                                          |

---

## AI Provider API Keys (Testing & Releases)

Used for integration tests in PR checks and package releases.

| Secret                                | Purpose                                | Referenced In                                                                                         |
| ------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                      | OpenAI API key                         | `pr-checks.yaml`, `reusable-release.yml`, `release-*.yml`                                             |
| `ANTHROPIC_API_KEY`                   | Anthropic API key                      | `pr-checks.yaml`, `reusable-release.yml`, `release-*.yml`, `cli-pr-checks.yml`, `continue-agents.yml` |
| `GEMINI_API_KEY`                      | Google Gemini API key                  | `pr-checks.yaml`, `reusable-release.yml`, `release-*.yml`                                             |
| `MISTRAL_API_KEY`                     | Mistral API key                        | `pr-checks.yaml`, `reusable-release.yml`, `release-*.yml`                                             |
| `VOYAGE_API_KEY`                      | Voyage AI embeddings API key           | `pr-checks.yaml`, `reusable-release.yml`, `release-*.yml`                                             |
| `RELACE_API_KEY`                      | Relace API key                         | `pr-checks.yaml`, `reusable-release.yml`, `release-*.yml`                                             |
| `INCEPTION_API_KEY`                   | Inception API key                      | `pr-checks.yaml`, `reusable-release.yml`, `release-*.yml`                                             |

---

## CI/CD & GitHub

| Secret             | Purpose                                                         | Referenced In                                                                                                         |
| ------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`     | Default GitHub Actions token (automatic)                        | Many workflows                                                                                                        |
| `CI_GITHUB_TOKEN`  | Elevated GitHub PAT for cross-repo operations and PR management | `preview.yaml`, `main.yaml`, `pr-checks.yaml`                                                                         |
| `NEXTCLI_API_KEY` | NextCLI platform API key for agent workflows                    | `run-continue-agent.yml`, `tidy-up-codebase.yml`, `snyk-agent.yaml`, `auto-fix-failed-tests.yml`, `cli-pr-checks.yml` |
| `RUNLOOP_API_KEY`  | Runloop API key for uploading sandbox blueprints                | `upload-runloop-blueprint.yml`                                                                                    |
| `SNYK_TOKEN`       | Snyk security scanning token                                    | `snyk-agent.yaml`                                                                                                     |

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
