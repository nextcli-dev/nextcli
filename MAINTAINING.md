# Maintaining NextCLI

NextCLI is a community continuation of [Continue](https://github.com/continuedev/continue). This checkout keeps the full Continue history. `upstream` is Continue and cannot be pushed to. `origin` is [nextcli-dev/nextcli](https://github.com/nextcli-dev/nextcli).

The checks companion lives in the sibling `nextcli-checks` directory and tracks [continuedev/checks](https://github.com/continuedev/checks) the same way. Its origin is [nextcli-dev/nextcli-checks](https://github.com/nextcli-dev/nextcli-checks).

## Sync with upstream

Continue's last commit on `main` when this copy was made is `5522c6f44` (2026-07-21), "docs: remove Sign in link (login flow retired)".

```bash
git fetch upstream
git merge upstream/main
```

Prefer merging `upstream/main` when you want the whole delta. Cherry-pick individual commits when a merge would fight the rebrand. Expect conflicts in docs, `package.json` display fields, and anything that mentions `continue.dev`.

Do not push to `upstream`. Its push URL is `DISABLE`.

## Identifiers left as Continue on purpose

These stay so current installs, imports, and published package names keep working:

| Identifier       | Current value                                                                     | Later value                         |
| ---------------- | --------------------------------------------------------------------------------- | ----------------------------------- |
| npm scope        | `@nextcli/cli` and the four libraries below; other packages stay `@continuedev/*` | remaining `@continuedev/*` packages |
| CLI command      | `cn`                                                                              | `nextcli`                           |
| Config directory | `~/.continue`, `.continue/`, `.continueignore`                                    | migrate into `~/.nextcli`           |

Changing any of these is a compatibility break. Do them one at a time, with a migration for the config directory, and publish under the new ids only after the old ones are either transferred or left as a thin wrapper.

The VS Code extension id is `nextcli.nextcli`.

## Services that are off

NextCLI does not call Continue-hosted services unless you opt in with your own endpoint.

- **Hub and sign-in.** Upstream had already removed hub login before this snapshot. `NEXTCLI_API_BASE` defaults to empty. CLI requests and the TypeScript SDK throw unless you pass a base URL. Config `uses:` slugs are not linked to a hub. The IDE banner no longer offers "Export cloud configs".
- **Version check.** The CLI does not call `api.nextcli.dev/cn/info` and does not send a machine id. Set `NEXTCLI_VERSION_INFO_URL` to a JSON endpoint that returns `{ "version": "..." }` if you want update checks.
- **Telemetry.** Anonymous telemetry defaults off (`allowAnonymousTelemetry` and the VS Code `continue.telemetryEnabled` setting). The CLI exports OpenTelemetry metrics only when `CONTINUE_CLI_ENABLE_TELEMETRY=1` or `CONTINUE_METRICS_ENABLED=1` and you have configured your own OTLP endpoint. There is no PostHog key in this tree. The docs site no longer loads Continue's GA4 tag, Reo script, or cookie banner.
- **Sentry.** This snapshot has no Sentry initialization and no hard-coded Continue DSN. Upstream had already removed those call sites. Do not add a DSN literal. If Sentry comes back, initialize it only when `NEXTCLI_SENTRY_DSN` is set and telemetry is allowed. With no DSN, it must not start.

## CI

`.github/workflows/ci.yml` runs on pull requests to `main`. Its last job, `ci`, is the only required status check. Nothing reruns after a merge: `main` requires pull requests to be up to date and squash-merged, so the merged commit is the tree CI already tested.

CI runs only the jobs a change can affect. `scripts/ci/affected.mjs` maps changed files to areas (`core`, `gui`, `vscode`, `cli`, `binary`, each package under `packages/`) and adds every area that depends on them, using the `file:` links and local package names in each `package.json`. Its reasoning is in the run summary. To see it for your branch:

```bash
node scripts/ci/affected.mjs --base origin/main --explain
```

- A docs-only change runs formatting and the PR title check only.
- An area whose own files changed, with no changed dependencies, runs only the tests related to the changed files (`jest --changedSince`, `vitest --changed`). Every other affected area runs its full suite.
- The CLI's Windows and macOS jobs run only when `extensions/cli/` changes.
- Lockfiles, `.nvmrc`, `.github/actions/`, `ci.yml` and `scripts/ci/` force a full run.

For a full run on a pull request, add the `ci:full` label and push, or run the CI workflow manually on the branch. A scheduled full run on `main` every Monday catches anything the narrowed selection misses. Release PRs always get a full run.

Pull request titles must follow [Conventional Commits](https://www.conventionalcommits.org/) (`fix(cli): ...`, `feat(vscode): ...`). The squash commit uses the title, and release-please reads it.

Other workflows:

| Workflow                     | Runs                               | Does                                                                  |
| ---------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `ai-checks.yml`              | `ai-review` label, or manually     | AI checks from `.checks/` via nextcli-checks, one job per check       |
| `release-prs.yml`            | push to `main`                     | Keeps the Release PRs up to date and creates releases when they merge |
| `publish-vscode.yaml`        | VS Code release, or manually       | Builds 8 targets, publishes to Open VSX and the Marketplace           |
| `release-cli.yml`            | CLI release, or manually (dry run) | Publishes `@nextcli/cli` to npm                                       |
| `cla.yaml`                   | PR opened or updated, PR comments  | CLA signatures, stored on the `cla-signatures` branch                 |
| `stale-issue-helper.yaml`    | daily                              | Marks and closes inactive issues and PRs                              |
| `delete-stale-branches.yaml` | weekdays                           | Deletes branches inactive for 60 days, except `backup/*`              |

Upstream workflows that NextCLI doesn't use yet are parked in `.github/workflows-archive/`, which GitHub does not run. Its README says what each needs to be revived.

## Releasing

Versions and changelogs come from merged pull request titles. [release-please](https://github.com/googleapis/release-please) keeps one Release PR per product open on `main`:

- `chore(main): release vscode X.Y.Z` bumps `extensions/vscode/package.json` and `extensions/vscode/CHANGELOG.md`.
- `chore(main): release cli X.Y.Z` bumps `extensions/cli/package.json` and `extensions/cli/CHANGELOG.md`.

A `fix:` or `feat:` title that touches a product's files, or the shared `core/` and `packages/`, adds to that product's Release PR. `docs:`, `chore:`, `ci:` and `test:` titles don't trigger a release. The configs are in `.github/release-please/`.

### VS Code extension

Even minor versions are stable, odd minor versions are pre-releases.

**Stable.** Merge the vscode Release PR. release-please creates the tag `vscode-vX.Y.Z` and its GitHub release, and `publish-vscode.yaml` builds all 8 targets. Approve the `production` deployment, and the job publishes to Open VSX and the Visual Studio Marketplace. The vscode Release PR only bumps the patch version. To start the next stable minor, merge a pull request whose squash commit body contains:

```text
Release-As: 1.6.0
```

**Pre-release.** In Actions, run Publish VS Code Extension on `main` with channel `pre-release`. It builds the next version on the odd minor above the current stable one (stable 1.4.x gives 1.5.0, then 1.5.1, ...), creates the tag and GitHub pre-release, and publishes in the `staging` environment. The pre-release version is not committed.

**Test build.** Run the same workflow with channel `dry-run` and any ref. It builds all 8 `.vsix` files as workflow artifacts and publishes nothing.

Publishing uses trusted publishing (OIDC), with no stored tokens:

- Open VSX: one trusted publisher for `nextcli.nextcli`, workflow `publish-vscode.yaml`, environment blank.
- Visual Studio Marketplace (publisher `nextcli`): workflow `publish-vscode.yaml` with environment `production`, and the same workflow with environment `staging`.

Both registries bind to the workflow file name, so don't rename `publish-vscode.yaml`. Both publish steps skip versions that already exist, so a failed publish job can be re-run.

### CLI

Merge the cli Release PR. release-please creates `cli-vX.Y.Z` and its GitHub release, and `release-cli.yml` builds, tests, packs and installs the tarball, then waits for approval of the `production` deployment before publishing to npm. To check a build without publishing, run CLI Release manually: it stops after packing.

npm trusted publishing is bound to `release-cli.yml`. Leave `NPM_TOKEN` unset to publish with the workflow's OIDC token.

After a CLI release, update the `@nextcli/cli` version pinned in nextcli-checks (`scripts/install-agent.sh`, `action.yml`, README) and move its `v2` tag.

`extensions/cli/LICENSE` and `extensions/cli/NOTICE` are copies of the repository root files. npm only packs files inside the package directory. Update both copies when the root files change.

### Libraries

`@nextcli/config-types`, `@nextcli/config-yaml`, `@nextcli/fetch`, `@nextcli/llm-info` and `@nextcli/openai-adapters` have no release workflow. The CLI and the extension build them from `packages/` and don't install them from npm. To publish them again, add each package to release-please as its own component.

## Repository settings

- `main` ruleset: pull request required, status check `ci` required and branches must be up to date, no force pushes or deletion.
- Merge button: squash only, PR title as the commit message, branches deleted after merge.
- Environments: `production` requires a reviewer and only accepts `vscode-v*` and `cli-v*` tags; `staging` only accepts `main`.
- The NextCLI Automation GitHub App (`NEXTCLI_APP_CLIENT_ID` variable, `NEXTCLI_APP_PRIVATE_KEY` secret) needs contents and pull request write access. release-please uses it so that Release PRs run CI and releases start the publish workflows.
- `NEXTCLI_SENTRY_DSN` only if error reporting should be on.
