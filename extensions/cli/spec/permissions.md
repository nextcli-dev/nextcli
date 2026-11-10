# Permissions

This file is the model the permission code implements. For users, see [`docs/cli/tool-permissions/`](../../../docs/cli/tool-permissions/index.mdx) and [`docs/cli/modes/`](../../../docs/cli/modes/index.mdx). For the files and the call flow, see [`src/permissions/README.md`](../src/permissions/README.md).

The behavior is pinned by [`permissionMatrix.test.ts`](../src/permissions/permissionMatrix.test.ts). Each row is a run setup, a tool call and the expected decision.

## Summary

Every tool call ends as `allow`, `ask` or `exclude`. The first rule that matches the call decides it. Two checks then run on every call, whatever the rules say: `--readonly` blocks the write tools, and `Bash` may be held to read-only commands. When nobody can answer, `ask` means refused.

| Permission | Meaning                                                 |
| ---------- | ------------------------------------------------------- |
| `allow`    | Runs without asking                                     |
| `ask`      | A person is asked. With nobody to answer, it is refused |
| `exclude`  | Not offered to the model. A call to it is refused       |

## Guarantees

No rule, flag or mode can undo these:

- `--readonly` never runs `Edit`, `MultiEdit` or `Write`.
- Under `--readonly`, `Bash` runs only read-only commands.
- A command `terminal-security` marks disabled (`rm -rf /`) never runs.
- A destructive command (a broad delete) always needs a person.
- `ask` with nobody to answer is refused.

So `--readonly --allow "*"` still can't write, and `cn -p --readonly --allow "Bash(* *)"` still can't run `curl`. Safety comes from these checks, not from the order of the rules.

## Deciding a call

`checkToolPermission` does four steps:

1. **First match.** The first rule that matches gives the base permission. No match means `ask`.
2. **Read-only.** Under `--readonly`, `Edit`, `MultiEdit` and `Write` become `exclude`.
3. **Bash check.** `Bash` has its own evaluator, from `terminal-security`. It rates every call:

   | Command                            | Result                                      |
   | ---------------------------------- | ------------------------------------------- |
   | Disabled (`rm -rf /`, `mkfs`)      | `exclude`, whatever the rule said           |
   | Destructive (broad delete)         | an `allow` becomes `ask`                    |
   | Not read-only (`npm test`, `curl`) | an `allow` becomes `ask` **in strict mode** |
   | Read-only (`ls`, `git diff`)       | the rule's permission                       |

   Strict mode is on when:

   - the run is `--readonly`, or
   - nobody can answer, and the matching rule didn't come from a flag.

   So `cn -p` with the default `Bash` allow runs only read-only commands, while `cn -p --allow Bash` runs `npm test`.

4. **Ask.** An `ask` goes to the person. With nobody to answer it is refused, and a headless run ends there.

### Offering tools

Before each request, `isToolOffered` picks the tools the model sees. A tool is offered when a call to it can run, or would ask and someone can answer. A rule for some arguments, like `Write(src/*)`, offers the tool. Offering is not the security boundary: every call still goes through `checkToolPermission`.

## Rules

A rule has:

- `tool`: a tool name, or a glob over names (`github_*`, `*`).
- `permission`: `allow`, `ask` or `exclude`.
- `argumentMatches` (optional): a glob for one argument. `Bash(npm test*)` becomes `{ tool: "Bash", argumentMatches: { command: "npm test*" } }`.
- `origin` (optional): `"flag"` for a rule from `--allow`, `--ask` or `--exclude`. Step 3 uses it.

All sources use one parser, `parseToolPattern` in `toolPattern.ts`. Its `PATTERN_ARGUMENT` table says which argument each tool's pattern matches (`Bash` → `command`, `Read`/`Write` → `filepath`, `Edit`/`MultiEdit` → `file_path`, `Diff` → `path`, `List` → `dirpath`, `Fetch` → `url`, `Search` → `pattern`). A pattern on any other tool, like `github_create_issue(x)`, throws `ToolPatternError`, and `cn` doesn't start.

A session's rules are a `ToolPermissions`: the ordered rules, plus two limits that aren't rules, `readonly` and `unattended`.

Within one source, excludes come first, then asks, then allows. So `--exclude Bash --allow "Bash(git log*)"` denies `git log`.

## Where the rules come from

`ToolPermissionService.buildPolicies` builds the list. It runs the same way at startup, on a mode switch and on a reload. Sources are listed in the order they're checked:

| Mode                       | Flags   | Agent file | `permissions.yaml`         | Then                                           |
| -------------------------- | ------- | ---------- | -------------------------- | ---------------------------------------------- |
| normal                     | ✓       | –          | ✓ (only excludes headless) | defaults                                       |
| normal or auto, agent file | ✓       | ✓          | ignored                    | `* allow` in the TUI, closed defaults headless |
| plan (`--readonly`)        | ✓       | ignored    | ignored                    | plan defaults                                  |
| auto, no agent file        | ignored | –          | ignored                    | `* allow` only                                 |

The defaults are one table in `defaultPolicies.ts`, with a column for each kind of run: TUI, headless, `--readonly` TUI, `--readonly` headless. A new built-in tool needs a row in every column; `defaultPolicies.test.ts` checks this. When unsure, make the headless default `exclude`.

`flagProcessor.ts` turns `--readonly` and `--auto` into the mode. The two together are an error.

## Matching

| Argument                                                        | An `allow` matches when                          | An `exclude` or `ask` matches when |
| --------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------- |
| Tool name                                                       | the name matches (`*`, `?`, case-sensitive)      | same                               |
| File path: `Read`, `Write`, `Edit`, `MultiEdit`, `Diff`, `List` | both the path as written and its real path match | either path matches                |
| `Bash` command                                                  | the line is one plain command that matches       | any command in the line matches    |
| `Fetch` URL, `Search` pattern                                   | the text matches the glob                        | same                               |

Paths are resolved from the working directory, with symlinks followed, and matched with `minimatch`.

`Bash` lines are split into commands with `splitCommand` from `terminal-security`. An exclude or ask also looks inside `&&`, pipes, `sh -c`, `$(...)` and wrappers like `env` or `timeout`, ignores the command's directory, and matches the pattern's words in order. A line it can't read (`python -c '...'`, `$CMD`) matches no `Bash(...)` rule and falls to the next rule.

## Kinds of run

"Nobody can answer" is the `unattended` limit. `services/index.ts` sets it when a run is headless and has no approver.

| Run                | Who answers `ask`                      | Rules                                                                                                  |
| ------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `cn`               | you                                    | as in the table above                                                                                  |
| `cn -p`            | nobody                                 | as above, with the closed headless defaults                                                            |
| `cn serve`         | the client, through `POST /permission` | TUI defaults; it is headless but not unattended                                                        |
| `cn review` worker | nobody                                 | closed headless defaults plus `allow` `Edit`, `MultiEdit`, `Write`. The operator's flags aren't passed |
| Subagent           | nobody                                 | the parent's rules plus `exclude Subagent`, re-read each request                                       |

The review worker's rules are set in `reviewWorker.ts`, and a subagent's in `subagent/executor.ts`.

A refused call in a headless run gets `Blocked by security policy: this tool call isn't allowed in an unattended run...`, and the run returns the answer so far.

## `~/.continue/permissions.yaml`

- **Format.** Three optional lists, `allow`, `ask` and `exclude`, in the same pattern syntax. `CONTINUE_GLOBAL_DIR` moves the directory. The file is created on first start.
- **Saving.** "Continue + don't ask again" appends a rule to `allow`. `generatePolicyRule` decides the rule: a non-Bash tool by name; a Bash command by command and subcommand (`Bash(npm test*)`), or exactly if the first argument is an option (`Bash(ls -la)`). A chained, redirected, wrapped or unreadable line saves nothing and is approved once.
- **Reading.** The file is re-read on every rebuild of the rules, so a saved rule applies to the next call.
- **Errors.** A bad structure (an unknown key, a value that isn't a list) makes `cn` ignore the file with a warning. A bad pattern stops `cn`, and the message names the file.

## Changing permissions

1. Edit the rows of `permissionMatrix.test.ts` that the change affects, in the same commit. A refactor leaves them unchanged.
2. A new built-in tool needs a row in `defaultPolicies.ts` for every kind of run.
3. Update this file, `src/permissions/README.md` and the user docs. `.checks/documentation-freshness.md` lists them.
