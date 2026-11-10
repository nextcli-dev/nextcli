# Tool Permissions System

The tool permissions system allows you to control which tools the AI can use and how it can use them. There are three permission levels:

- **allow**: The tool will be executed automatically without asking for permission
- **ask**: The tool will prompt the user for permission before execution
- **exclude**: The tool will be filtered out entirely and won't be available to the AI

## Default Policies

The system comes with sensible default policies:

Defaults are one table in `defaultPolicies.ts`, with a column for each kind of run (TUI, headless, `--readonly` in the TUI, `--readonly` headless). A new built-in tool needs a row.

- Read-only tools (`Read`, `List`, `Search`, `Diff`, ...) are **allowed**
- Write operations (`Edit`, `MultiEdit`, `Write`) **ask**
- `Bash`, `Fetch`, `UploadArtifact`, `Subagent` and MCP tools differ between the TUI and headless mode:

| Tool                      | TUI       | Headless (nobody to approve)                                                                                                      |
| ------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Bash`                    | **ask**   | **allow** only for commands the evaluator approves on its own (`ls`, `cat`, `git status`...), otherwise **ask**, which is refused |
| `Fetch`, `UploadArtifact` | **allow** | **exclude**                                                                                                                       |
| `Subagent`, MCP, others   | **ask**   | **exclude**                                                                                                                       |

Any `ask` in a headless run is refused, because nobody can answer it.

Two things are decided per call in `checkToolPermission`, not by policy order, so no rule can undo them:

- `ToolPermissions.readonly` (`--readonly`): `Edit`, `MultiEdit` and `Write` are excluded, and `Bash` is evaluated strictly.
- `ToolPermissions.unattended` (headless): an allow that isn't an operator's flag (`origin: "flag"`), such as the default Bash allow or an agent file's, is evaluated strictly.

Strict means the tool's own evaluator must approve the call by itself (`evaluateTerminalCommandSecurity(..., { strict: true })`); anything else asks. A headless run takes only the excludes from `permissions.yaml`.

`Bash(glob)` rules are matched per command with terminal-security's `splitCommand`: an allow covers only a line that is one simple command, and an exclude or ask covers a line where any command matches, or whose commands can't be read.

## How It Works

1. **Offering.** `getRequestTools` (`stream/handleToolCalls.ts`) keeps the tools `isToolOffered` accepts: a call can run, or would ask and someone is present. A rule scoped to some arguments (`Write(src/*)`) offers the tool; each call is still checked.
2. **Deciding.** `executeStreamedToolCalls` (`stream/streamChatResponse.helpers.ts`) calls `checkToolPermission` for every call. `allow` runs it. `exclude` cancels it with `Command blocked by security policy` (headless: a longer message that points at `--allow`), and a headless run returns after a cancelled call.
3. **Asking.** `ask` goes through `requestUserPermission` to `toolPermissionManager` (`permissionManager.ts`), which emits the request to the UI (`ui/components/ToolPermissionSelector.tsx`) or to `cn serve`'s `POST /permission`. Without an approver the request is denied. "Continue + don't ask again" calls `rememberToolApproval` (`policyWriter.ts`) and then `reloadPermissions`, so the saved rule applies to the next call.

## Files

- `types.ts`: `ToolPermissionPolicy`, `ToolPermissions` (policies plus the `readonly` and `unattended` limits), `ToolPermissionsSource`
- `defaultPolicies.ts`: the defaults table
- `toolPattern.ts`: the one parser for `Tool`, `Tool(glob)` and tool-name globs, `PATTERN_ARGUMENT`, and the exclude → ask → allow ordering within a source
- `precedenceResolver.ts`: normal mode's layering of flags, `permissions.yaml` and defaults
- `permissionChecker.ts`: `checkToolPermission`, `isToolOffered`, path and Bash matching
- `permissionsYamlLoader.ts`: reads and creates `~/.continue/permissions.yaml`
- `policyWriter.ts`: what "don't ask again" remembers, and how it is written
- `permissionManager.ts`: pending approval requests
- `../services/ToolPermissionService.ts`: builds the policies per mode (`buildPolicies`) from flags, the agent file and the yaml; mode switches and reloads rebuild the same way
- `permissionMatrix.test.ts`: the behavior spec. A behavior change edits its rows in the same commit.

The user-facing description is `docs/cli/tool-permissions.mdx`; the model is written up in `../../spec/permissions.md` and `../../spec/modes.md`. Both must change with the code (`.checks/documentation-freshness.md` checks this).
