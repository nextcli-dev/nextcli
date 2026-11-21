---
name: precheck
description: Self-review a nextcli diff with the repo's .checks/*.md and AGENTS.md review rules, fix what they flag, and report. Use before every push.
---

# Precheck the diff

Paths are relative to the nextcli repo root. Most findings the AI checks post
on PRs here (anti-slop and stale comments above all) are visible in the diff
before it is pushed. This skill applies the same checks yourself, at no model
cost beyond your own session.

## 1. Scope

```bash
git fetch -q origin
git diff --name-only --merge-base origin/main
node scripts/ci/affected.mjs --base origin/main --explain
```

If a command fails, say which one and what it printed, then continue with
what you can still check. Don't look for credentials or read outside the
repository.

## 2. Pick the checks

Read the frontmatter of every `.checks/*.md`. A check applies when one of its
`paths:` globs matches a changed file. Also apply the "Reviewing changes"
section of `AGENTS.md`. Ignore `.continue/checks/` and `.continue/agents/`:
they are inherited and not what CI runs.

## 3. Apply each check to the diff

Read `git diff --merge-base origin/main` and judge it as the CI reviewer would,
using each check's own wording and its finding limit. Then look for what the
checks have caught here most often:

- comments that restate the code, promise more than it does ("never", "always",
  time bounds the code doesn't enforce), or no longer match it;
- one-use helpers, wrappers and aliases; interfaces with one implementation;
- defensive guards and fallbacks for cases the types or callers rule out;
- fields, exports and options nothing reads;
- logic duplicated instead of reusing an existing export (`packages/*`, the
  CLI and the GUI each having their own copy);
- forgotten touchpoints: callers, docs, configs, the other product (CLI vs
  extension) that depends on the changed behavior;
- tests that can't fail. For each new or changed test, revert the code change
  it covers and run it: it must fail.

Fix each finding, re-run what showed it, and note the finding and the change:
the report in "Stop when" needs both.

## 4. Run what CI runs

Run the per-area commands from `AGENTS.md` ("Before you finish") for every
area `affected.mjs` printed, build first, and run prettier on the changed
files. Report failures verbatim.

## Example

"Precheck my branch before I push."

| Check                | Where                                 | Problem                                         | Change                                    |
| -------------------- | ------------------------------------- | ----------------------------------------------- | ----------------------------------------- |
| anti-slop            | `extensions/cli/src/compaction.ts:41` | `?? 0` fallback for a count the type guarantees | removed                                   |
| stale-comments       | `extensions/cli/src/fitHistory.ts:12` | comment says "drops the newest turn first"      | rewritten: oldest tool outputs first      |
| forgotten touchpoint | `docs/cli/headless.mdx`               | `--max-cost` default changed, docs still say 1  | not fixed: docs owner decides the wording |

CI (`cli` area): lint, build, smoke, unit and e2e pass; `prettier --check` clean.

## Stop when

You end with that report: one row per finding (check, file:line, problem,
what changed or "not fixed: why"), then the CI commands and their results.
Answer PASS only when nothing was found. If you run out of steps, report
what you have in the same format.
