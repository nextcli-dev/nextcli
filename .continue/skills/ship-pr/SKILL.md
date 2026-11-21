---
name: ship-pr
description: Branch, commit and open a nextcli PR, or rebase a branch or stack. Use when asked to commit, open a PR, push review fixes or rebase onto main.
---

# Ship a pull request

Paths are relative to the nextcli repo root. Commit, push or open a PR only
when the user asked for it. Opening a PR includes pushing its branch. The
user merges and force-pushes; you never force-push, you give the command.

## 1. Start clean

```bash
git fetch origin --prune
git status --short --branch
```

Changes you didn't make belong to the user: stop and ask. Never `git stash
pop` a stash you didn't create, and don't make a new clone or worktree unless
asked. New work branches from the fetched main:

```bash
git switch -c <type>/<short-name> origin/main && git branch --unset-upstream
```

Review fixes go on the PR under review. Check it is still open first
(`gh pr view <N> --json state`); a merged PR means a new branch and PR.

## 2. Check what you stage

`git add` only the files you mean to commit, then read `git diff --cached
--stat` and the diff:

- no local data: results, baselines, traces, sessions, paths from this machine;
- no build output (`dist/`, `out/`, `.vsix`, generated catalogs you didn't
  regenerate on purpose);
- no `package-lock.json` churn from prepackage or a different npm version:
  `git checkout -- '*package-lock.json'` unless dependencies changed;
- no unrelated behavior change bundled in. Ask before splitting work into
  extra PRs, and before folding an unrelated fix into this one.

## 3. Precheck

Run the `precheck` skill. Don't commit with a failing area check.

## 4. Commit and open the PR

- Title in Conventional Commits with a scope: `fix(cli): ...`,
  `feat(vscode): ...`. release-please builds versions from it, and
  `docs:`/`chore:`/`ci:`/`test:` don't release.
- Body from `.github/pull_request_template.md`: what changed and why under
  Description, the commands you ran and their results under Tests, "N/A" with
  a reason under Screen recording. Tick docs/tests only when true; leave the
  Contributing Guide and CLA boxes for the author.
- Describe the approach; don't name competitor products.

```bash
gh pr create --base main --title "<title>" --body-file <file>
```

If `gh` isn't authenticated or a command fails, say which command and what it
printed, then give the user the title, the body and the `gh pr create`
command to run. Don't look for credentials or read outside the repository.

## 5. Rebase and stacks

Never merge `main` into a PR branch. Rebase instead:

```bash
git fetch origin && git rebase origin/main      # re-run precheck afterwards
git ls-remote origin refs/heads/<branch>        # the SHA the lease must name
```

For a stack, rebase each branch onto its new base in order, and retarget a PR
whose base merged with `gh pr edit <N> --base main` (CI doesn't rerun on
retarget; the push does). Hand the user one command per branch, with an
absolute path and the SHA from `ls-remote`, not from memory:

```bash
git -C /abs/path/to/nextcli push --force-with-lease=<branch>:<remote-sha> origin <branch>
```

## Example

"Ship the scroll fix for the chat panel."

```text
Branch:   fix/gui-chat-autoscroll (from origin/main)
Commit:   4f2a9c1 fix(gui): keep auto-follow when the chat itself scrolls
Left out: extensions/vscode/build/nextcli-1.6.24.vsix (build output)
Pushed:   yes, origin/fix/gui-chat-autoscroll
PR:       not opened, gh is not authenticated. Run:
          gh pr create --base main --title "fix(gui): ..." --body-file /tmp/pr.md
```

## Stop when

You end with a status block: branch, commits (SHA and title), what you left
out of the commit, pushed or not, PR link, CI state (`gh pr checks <N>`), and
the exact commands left for the user, including the force-push command with
the `ls-remote` SHA whenever the branch was rebased.
