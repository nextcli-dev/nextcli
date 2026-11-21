---
name: review-fix
description: Rate and fix review findings on a nextcli PR (AI-checks report, Copilot, owner). Use when asked to fix or go through a PR's review comments.
---

# Fix review findings

Paths are relative to the nextcli repo root. Most review rounds here came from
fixing the one case a finding named and missing its siblings, so the sweep in
step 4 is the point of this skill.

## 1. Check the PR is still open

```bash
gh pr view <N> --json state,headRefName,baseRefName,mergedAt
```

A merged or closed PR gets no more commits: put the fixes on a new branch from
`origin/main` and a new PR. Otherwise check out the head branch and pull it.

## 2. Collect every finding

```bash
gh pr view <N> --comments                       # AI-checks report, owner replies
gh api "repos/nextcli-dev/nextcli/pulls/<N>/comments" --paginate \
  --jq '.[] | {path, line, user: .user.login, body}'   # inline comments
```

The AI report is one comment edited in place on each run. Read its latest
version, not an older quote of it.

If `gh` isn't authenticated or a command fails, say which command and what it
printed, and work from review text the user saved or pasted, or stop. Don't
look for credentials or read outside the repository.

## 3. Rate each finding

For each one, say **valid**, **partial** or **invalid**, with the reason and
the file and line you checked. Findings were invalid here before because:

- the reviewer saw a truncated diff (`max-diff-bytes`), so code it called
  missing was in the part it never got;
- the code is intentional in a stack of PRs and used by a later one;
- the review ran against an older base;
- it doesn't reproduce: show the run or test that proves it.

Ask the user before acting on a partial finding or skipping a valid one.

## 4. Sweep for siblings of every valid finding

Before fixing, list every place the same root cause can show up:

- other input forms: relative, absolute, `~`, `file://`, Windows `\` and short
  names (`RUNNER~1`), CRLF, percent-encoding, multi-root workspaces;
- other callers and implementers of the changed function, type or config key
  (`git grep`);
- other run modes: TUI, headless `-p`, `cn serve`, review worker, `--readonly`,
  subagents; and for shared logic, the extension as well as the CLI.

Fix the root cause once, for all of them. Then answer in one sentence why the
first version missed it.

## 5. Fix in place

- Same branch, one commit per finding (`fix(<scope>): ...`).
- Smallest diff to the existing code. Ask before deleting or replacing working
  logic, a flag, a dependency or a table.
- Every fix gets a test that fails without it. Revert the fix, watch the test
  fail, restore it.

## 6. Check, then hand back

Run the `precheck` skill on the whole branch. Update the PR body if the change
no longer matches it (`gh pr edit <N> --body-file ...`). Push only if asked;
for a rebased branch give the force-push command from the `ship-pr` skill.

## Example

"Go through the review on PR 129 and fix what's real."

| Finding                                                     | Verdict                                     | Commit                                                        |
| ----------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| `cn serve` drops AskQuestion although its client can answer | valid; sibling: subagents had the same gate | `a1b2c3d fix(cli): keep AskQuestion when a client can answer` |
| `policyWriter` adds an unused export                        | invalid: used by the next PR in the stack   | not fixed: intentional                                        |

Missed first because the test covered headless only. Branch not pushed; run
`git push origin fix/serve-ask-question`.

## Stop when

You report a table with one row per finding (finding, verdict and reason,
commit SHA or "not fixed: why") plus the branch state: pushed or not, and the
command the user still has to run.
