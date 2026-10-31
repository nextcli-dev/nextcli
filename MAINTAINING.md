# Maintaining NextCLI

NextCLI is a community continuation of [Continue](https://github.com/continuedev/continue). This checkout keeps the full Continue history. `upstream` is Continue and cannot be pushed to. `origin` is [nextcli-dev/nextcli](https://github.com/nextcli-dev/nextcli). Nothing in the rebrand has been committed yet.

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

| Identifier                         | Current value                                  | Later value                |
| ---------------------------------- | ---------------------------------------------- | -------------------------- |
| npm scope                          | `@continuedev/*`                               | `@nextcli/*`               |
| VS Code publisher and extension id | `Continue.continue`                            | a NextCLI publisher and id |
| CLI command                        | `cn`                                           | `nextcli`                  |
| Config directory                   | `~/.continue`, `.continue/`, `.continueignore` | migrate into `~/.nextcli`  |

Changing any of these is a compatibility break. Do them one at a time, with a migration for the config directory, and publish under the new ids only after the old ones are either transferred or left as a thin wrapper.

## Services that are off

NextCLI does not call Continue-hosted services unless you opt in with your own endpoint.

- **Hub and sign-in.** Upstream had already removed hub login before this snapshot. `NEXTCLI_API_BASE` defaults to empty. CLI requests and the TypeScript SDK throw unless you pass a base URL. Config `uses:` slugs are not linked to a hub. The IDE banner no longer offers "Export cloud configs".
- **Version check.** The CLI does not call `api.nextcli.dev/cn/info` and does not send a machine id. Set `NEXTCLI_VERSION_INFO_URL` to a JSON endpoint that returns `{ "version": "..." }` if you want update checks.
- **Telemetry.** Anonymous telemetry defaults off (`allowAnonymousTelemetry` and the VS Code `continue.telemetryEnabled` setting). The CLI exports OpenTelemetry metrics only when `CONTINUE_CLI_ENABLE_TELEMETRY=1` or `CONTINUE_METRICS_ENABLED=1` and you have configured your own OTLP endpoint. There is no PostHog key in this tree. The docs site no longer loads Continue's GA4 tag, Reo script, or cookie banner.
- **Sentry.** This snapshot has no Sentry initialization and no hard-coded Continue DSN. Upstream had already removed those call sites. Do not add a DSN literal. If Sentry comes back, initialize it only when `NEXTCLI_SENTRY_DSN` is set and telemetry is allowed. With no DSN, it must not start.

## CI

Active workflows, adapted only where they named the Continue repository:

- `.github/workflows/pr-checks.yaml`
- `.github/workflows/cli-pr-checks.yml`
- `.github/workflows/main-build.yaml`
- `.github/workflows/pr-build-upload-vsix.yaml`
- `delete-stale-branches.yaml`, `label-merged-prs.yml`, `stale-issue-helper.yaml`

`release-cli.yml` is manual on purpose (`workflow_dispatch` with a version input). The other release and preview workflows are limited to `workflow_dispatch`, and their original triggers are commented at the top of each file. Turn one of those back on only after the secrets below exist, and point `repository:` at `nextcli-dev/nextcli`.

Removed because they existed for Continue's own operations: CLA assistant, Continue agents, auto-fix-failed-tests, Snyk agent, metrics, similar-issues, auto-assign, the weekly tidy-up agent, and Runloop blueprint upload.

## Releasing the CLI

`@nextcli/cli` is published by `.github/workflows/release-cli.yml` (`CLI Release` in the Actions tab). The source version stays `0.0.0-dev`. The workflow stamps the version you pass in, packs the tarball, and checks that a global install of that tarball prints the same version.

Run it from `main`. The first run should use `dry_run: true`. That packs and runs `npm publish --dry-run` without tagging. A second run with `dry_run: false` publishes and creates the `cli-vX.Y.Z` tag and GitHub release.

Trusted publishing on npm is tied to the workflow file name. Configure it only after this file is on `main`, and name the workflow `release-cli.yml`.

The first publish has to use a token, because trusted publishing can only be turned on after the package exists:

1. Create a short-lived granular npm token scoped to the `nextcli` organization and store it as the `NPM_TOKEN` secret.
2. Publish with `dry_run: false`.
3. On npmjs.com, add a trusted publisher for repository `nextcli-dev/nextcli` and workflow `release-cli.yml`.
4. Delete the `NPM_TOKEN` secret and revoke the token. Later releases leave `NPM_TOKEN` unset and use the workflow's OIDC token.

`extensions/cli/LICENSE` and `extensions/cli/NOTICE` are copies of the repository root files. npm only packs files inside the package directory. Update both copies when the root files change.

## Secrets needed before publishing

- VS Code Marketplace and Open VSX tokens, after the publisher id decision above
- `NPM_TOKEN` for the first `@nextcli/cli` publish only, then trusted publishing as above
- `NEXTCLI_SENTRY_DSN` only if error reporting should be on
- A docs host for `docs.nextcli.dev` if GitHub Pages (`docs-gh-pages.yml`) is re-enabled

## What not to commit by accident

`upstream` push is disabled. Review `git status` before the first commit. The rebrand, the disabled workflows, and this file are all local changes on `main`.
