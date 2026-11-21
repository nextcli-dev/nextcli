---
name: Trust boundary
description: Permissions, workspace trust, environment and path handling for untrusted input
alwaysApply: false
globs:
  - "**/extensions/cli/src/permissions/**"
  - "**/extensions/cli/src/tools/**"
  - "**/extensions/cli/src/workspaceTrust.ts"
  - "**/extensions/cli/src/projectEnv.ts"
  - "**/packages/terminal-security/**"
  - "**/core/tools/**"
  - "**/extensions/vscode/package.json"
paths:
  - "**/extensions/cli/src/permissions/**"
  - "**/extensions/cli/src/tools/**"
  - "**/extensions/cli/src/workspaceTrust.ts"
  - "**/extensions/cli/src/projectEnv.ts"
  - "**/packages/terminal-security/**"
  - "**/core/tools/**"
  - "**/extensions/vscode/package.json"
---

# Trust boundary

A repository under review, its files and the model's tool arguments are untrusted.

- **Decide at call time.** Safety is enforced when a call is checked (`checkToolPermission` in `src/permissions/permissionChecker.ts`), never by the order of a policy list or by filtering patterns beforehand.
- **`--readonly` is a ceiling.** A flag can turn a tool on, but under `--readonly` Edit, MultiEdit and Write never run and Bash runs only strictly read-only commands. Precedence stays first-match: flags, agent file, `~/.continue/permissions.yaml`, defaults. Unattended runs take only `exclude` rules from the yaml.
- **Repository config can't relax a guard.** A VS Code setting that loosens security has `"scope": "machine"`. A project `.env` can't set variables that change how processes start: extend the denylist in `src/projectEnv.ts` (`BASH_ENV`, `ZDOTDIR`, `SHELLOPTS`, `NODE_OPTIONS`...) rather than special-casing a caller.
- **Stores are written atomically.** Trust stores and lock files use read-modify-write through a temp file and rename. A lock is never taken over while its pid is alive, whatever its age.
- **Paths.** Decode percent-encoding (`%2F`, `%5C`) first, then normalize, then reject a `..` path segment. `startsWith("..")` is wrong both ways: it rejects `..foo` and misses encoded separators.
