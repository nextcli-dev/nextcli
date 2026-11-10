# Permissions

The user-facing description is [`docs/cli/tool-permissions/`](../../../docs/cli/tool-permissions/index.mdx) and [`docs/cli/modes/`](../../../docs/cli/modes/index.mdx). This file records the model the code implements and where each part lives. The behavior itself is pinned by [`src/permissions/permissionMatrix.test.ts`](../src/permissions/permissionMatrix.test.ts): every row is a run setup, a tool call and the expected decision. A change in behavior edits the rows it changes in the same commit; a refactor leaves them unchanged.

## Permission levels

Every tool call ends with one of three permissions:

- `allow`: the tool runs without asking.
- `ask`: a person is asked. When nobody can answer, the call is refused.
- `exclude`: the tool is not offered to the model, and a call to it is refused.

## Rules

A rule (`ToolPermissionPolicy`, [`src/permissions/types.ts`](../src/permissions/types.ts)) is:

- `tool`: a tool name or a glob over tool names (`github_*`, `*`).
- `permission`: `allow`, `ask` or `exclude`.
- `argumentMatches`: optional, one glob for the tool's pattern argument. `Bash(npm test*)` becomes `{ tool: "Bash", argumentMatches: { command: "npm test*" } }`.
- `origin`: `"flag"` for a rule given on the command line. Nothing else sets it.

Every source goes through one parser, `parseToolPattern` in [`src/permissions/toolPattern.ts`](../src/permissions/toolPattern.ts). `PATTERN_ARGUMENT` there lists the tools that take a pattern and the argument it matches (`Bash` → `command`, `Read` → `filepath`, `Write` → `filepath`, `Edit`/`MultiEdit` → `file_path`, `Diff` → `path`, `List` → `dirpath`, `Fetch` → `url`, `Search` → `pattern`). A pattern on any other tool throws `ToolPatternError`; `cn` refuses to start rather than keep a rule that would never match. Within one source the rules are ordered exclude, ask, allow (`patternListsToPolicies`).

A session's rules are a `ToolPermissions`: the ordered `policies`, plus two limits that are not rules, `readonly` (`--readonly`) and `unattended` (nobody can approve).

## Sources and their order

[`ToolPermissionService.buildPolicies`](../src/services/ToolPermissionService.ts) builds the list the same way on initialization, on a mode switch and on a reload:

| Mode                               | Rules, first match wins                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| plan (`--readonly`)                | flags, then the plan defaults. `permissions.yaml` and the agent file are ignored.                                                             |
| normal or auto, with an agent file | flags, then the agent file's rules, then `* allow` in the TUI or the closed headless defaults when unattended. `permissions.yaml` is ignored. |
| auto, no agent file                | `* allow`. Flags and `permissions.yaml` are ignored.                                                                                          |
| normal, no agent file              | flags, then `permissions.yaml` (only its excludes when unattended), then the defaults (`resolvePermissionPrecedence`).                        |

The defaults are one table in [`src/permissions/defaultPolicies.ts`](../src/permissions/defaultPolicies.ts) with a column for each kind of run: TUI, headless, `--readonly` in the TUI, `--readonly` headless. A new built-in tool needs a row in every column; `defaultPolicies.test.ts` checks this, and the root AGENTS.md says to make the headless default `exclude` when in doubt.

## Deciding a call

`checkToolPermission` in [`src/permissions/permissionChecker.ts`](../src/permissions/permissionChecker.ts):

1. The first rule that matches the call gives the base permission. No match means `ask`.
2. `readonly` excludes `Edit`, `MultiEdit` and `Write`, whatever matched.
3. A tool with its own evaluator (today only `Bash`, through `terminal-security`) is consulted. `disabled` always wins. The evaluation is **strict** when `readonly` is set, or when `unattended` is set and the matching rule is not an operator's flag; a strict allow covers only calls the evaluator approves on its own (the read-only commands), and everything else becomes `ask`. Outside strict mode an allow is taken as given, except that a destructive command (`requiresHumanApproval`) still asks.
4. The stream refuses an `ask` when nobody can answer (`streamChatResponse.helpers.ts`), and a headless run ends after a refused call (`handleToolCalls.ts`).

Safety therefore comes from step 2 and step 3 on every call, not from rule order. `--readonly --allow "*"` still can't write, and `cn -p --allow "Bash(* *)" --readonly` still can't run `curl`.

### Matching

- Tool names: exact, or a glob with `*` and `?`. Case-sensitive.
- File paths (`Read`, `Write`, `Edit`, `MultiEdit`, `Diff`, `List`): `minimatch` against the path resolved from the working directory, with symlinks followed. An allow must match the path as written and its real path; an exclude or ask matches either.
- `Bash`: `splitCommand` from `terminal-security` splits the line into the simple commands it runs. An allow matches only a line that is one plain, readable command matching the glob. An exclude or ask matches when any command in the line matches, with the command's directory ignored and the pattern's other words matched in order, so it also covers wrappers, `sh -c`, substitutions and continuations. A line it can't read (`python -c`, `$CMD`) matches no scoped rule and falls to the next rule.
- Everything else (`Fetch`, `Search`): a plain glob over the argument's text.

### Offering tools

`isToolOffered` decides which tools go in the request. A tool is offered when a call to it can run, or would ask and someone can answer. A rule scoped to some arguments offers the tool; the call is still checked. Offering is not the security boundary; `checkToolPermission` is.

## Command line flags

`--allow`, `--ask` and `--exclude` each take a pattern and can be repeated. They become rules with `origin: "flag"` and come before every other source. Because `--exclude` rules come before `--allow` rules, `--exclude Bash --allow "Bash(git log*)"` denies `git log`.

```bash
cn --allow Read --ask Write --exclude Bash
cn --readonly "Help me understand this codebase"
cn -p "Fix the failing test" --allow "Bash(npm test*)" --allow Edit
```

`--readonly` and `--auto` set the mode (`flagProcessor.ts`); together they are an error.

## `~/.continue/permissions.yaml`

Personal rules, in the same pattern syntax, under `allow`, `ask` and `exclude` ([`src/permissions/permissionsYamlLoader.ts`](../src/permissions/permissionsYamlLoader.ts)). `CONTINUE_GLOBAL_DIR` moves the directory. The file is created on first start and rewritten by "Continue + don't ask again" ([`src/permissions/policyWriter.ts`](../src/permissions/policyWriter.ts)), which appends to `allow`. `generatePolicyRule` decides what is remembered: a non-Bash tool by name; a Bash command by command and subcommand (`Bash(npm test*)`), or exactly when the first argument is an option (`Bash(ls -la)`); nothing for a chained, redirected, wrapped, `sh -c` or unreadable line, which is approved once.

An invalid structure makes the loader ignore the file with a warning. An invalid pattern throws, with the file path in the message. The file is read on every rebuild of the rules, so a saved rule applies to the next call in the same session.

## Headless and other unattended runs

`unattended` is set when `headless` is true and nobody can approve (`services/index.ts`). `cn -p` and `cn review` are unattended; `cn serve` is headless but answers asks through `POST /permission`, so it keeps the TUI defaults. The review worker runs with the closed defaults plus `allow` for `Edit`, `MultiEdit` and `Write` (`reviewWorker.ts`), and does not receive the operator's flags. A subagent runs with the parent's `ToolPermissions` plus `exclude Subagent`, read for each request so a mode switch applies (`subagent/executor.ts`); its stream has no approval callback, so an `ask` is refused.

A refused call in a headless run gets the message `Blocked by security policy: this tool call isn't allowed in an unattended run...` and the run returns the answer so far.
