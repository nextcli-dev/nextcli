---
name: root-cause
description: Research a nextcli bug's cause before more code. Use when a second fix failed or it worked in an earlier version; for one red CI run use ci-triage.
---

# Find the root cause

Paths are relative to the nextcli repo root. Patching one symptom at a time
has cost several review and CI rounds here; the causes were design-level each
time (hook failures nobody saw, shared state changed by toggles, assertions
that passed without the behavior, CI and local environments that differed).
This skill produces evidence and options, not code.

## 1. History

- "It worked in version X": diff the release tags before anything else.

  ```bash
  git tag --list 'cli-v*' 'vscode-v*' --sort=-v:refname | head
  git diff <good-tag> <bad-tag> --stat -- <area>
  ```

- Who changed the area, and why: `git log --oneline -- <path>`,
  `git log -S '<symbol>'`, `git log -L :<function>:<file>`. Read the PRs
  (`gh pr view <N>`) and their review comments.
- Earlier attempts at this same problem: list them and what each one missed.

## 2. Evidence

- CI: `gh run list --workflow ci.yml --limit 20` across main and the branch;
  when it started failing, and the first failing commit.
- Logs and traces: `~/.continue/logs/cn.log` (`--log-level debug`),
  `NEXTCLI_TRACE=basic` JSONL, e2e artifacts, the extension host log.
- A minimal reproduction, run locally, that fails the same way.

When a source is missing (no CI access, `gh` not authenticated, no tag for the
version, no logs), say which one and why, and go on with what the repository
has: `git log`, the diff, and `git bisect run` on the reproduction. Don't look
for credentials or read outside the repository.

## 3. Model the system

Write down, briefly: the state involved and who changes it, the order of
events (async, lifecycle, abort), the inputs it accepts (paths, run modes,
platforms), and every difference between where it works and where it fails
(Node or VS Code version, OS, CI vs local, config).

## 4. Present before changing code

Give the user:

- the root causes, each with the evidence for it;
- two or three options, with the trade-off of each, and your recommendation;
- what would prove the fix: a test that fails now and passes after.

Prefer the smallest change to the existing code. A rewrite, or deleting
working logic, needs the user's agreement first.

## Example

"@-mentions found my files in 1.6.20; now they don't, and two fixes didn't help."

1. Root cause: `vscode-v1.6.20..v1.6.21` changed the ignore walk to skip
   dot-folders, so `.github/` files never reach the ranking. Evidence: the tag
   diff, and the repro listing 0 results for `.github/workflows/ci.yml`.
2. Earlier fixes changed the ranking weights, which never see those files.
3. Options: (a) narrow the skip to `.git/` (recommended, 1 line); (b) add an
   allowlist. Proof: a test that searches `.github/` fails now, passes after.

## Stop when

The user has the root causes with evidence and the options, and has chosen
one. Then implement with the normal flow (`precheck`, `ship-pr`).
