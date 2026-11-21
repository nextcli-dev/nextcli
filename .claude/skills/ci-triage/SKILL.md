---
name: ci-triage
description: Find why a failing nextcli CI run failed and fix the cause. Use when a PR's CI is red, a job fails on main, or a failure is called flaky.
---

# Triage a red CI run

Paths are relative to the nextcli repo root. `MAINTAINING.md` ("CI") explains
how jobs are selected; `extensions/vscode/e2e/README.md` covers e2e failures.
For an AI-checks (nextcli-checks) job, use `checks-debug` instead.

## 1. Read the failure

```bash
gh pr checks <N>                                  # or: gh run list --branch <branch> --limit 5
gh run view <run-id> --log-failed | tail -200
```

Find the first real error, not the last line. For `vscode-e2e`, download the
artifacts (`gh run download <run-id>`): screenshot, `exthost.log`,
`chromedriver.log`.

If `gh` isn't authenticated or a command fails, say which command and what it
printed, and work from logs the user saved or pasted, or stop. Don't look for
credentials or read outside the repository.

## 2. Classify it, with evidence

- **Regression in this diff.** The failing test or file relates to the change.
  Reproduce it locally with the area's command from `AGENTS.md`.
- **Fails on main too.** Prove it: `gh run list --branch main --workflow ci.yml
--limit 10` and the same job failing there. Then it is a separate fix PR,
  not a reason to merge this one red.
- **Infrastructure.** Runner or service outage, or Dependabot PRs, which can't
  read the GitHub App `private-key` secret. Say which, and link the evidence.
- **Deprecation drift.** `ci-scripts` fails `check-deprecations.mjs --strict`
  because an upstream package was deprecated, unrelated to the diff. Fix the
  dependency or allowlist entry in its own PR.

"Flaky" is a claim that needs the same test passing and failing on the same
commit in run history. Without that, treat it as a regression.

## 3. Check the known recurring causes

- `gui/src/components/find/useElementSize.ts`: a timer firing after test
  teardown ("window is not defined").
- Windows CLI jobs: short paths like `RUNNER~1` versus `realpath`, `\` versus
  `/`, CRLF.
- Timing assertions with tight margins on slow runners.
- Tests that pin a value from the models.dev catalog snapshot, which the weekly
  `sync-models` PR changes.

## 4. Fix the cause

- No retries, sleeps or skips as a fix, and never quarantine an e2e test.
- Don't add matrix dimensions: 12 jobs is the limit for one CI mode. Repeat
  inside a job (`E2E_REPEAT`, the `e2e:stress` label).
- Run the area's full commands locally before pushing.
- If this is the second fix for the same failing area and it still fails,
  stop and use the `root-cause` skill.

## Example

"CI on PR 188 is red in `ci-scripts`, but I only touched the GUI."

- Class: deprecation drift. `check-deprecations.mjs --strict` fails on
  `inflight@1.0.6`, deprecated upstream yesterday; main's scheduled run fails
  the same way (run link).
- Not this PR's change; don't re-run hoping it passes.
- Fix: a separate PR that bumps `glob` (drops `inflight`). Local
  `node scripts/ci/check-deprecations.mjs --strict` passes with it.

## Stop when

You state the class with its evidence (log line, run links), the fix and the
local command that now passes. Or the cause is outside this PR and you name
the follow-up it needs.
