# Tool Permissions System

The tool permissions system controls which tools the model can use and when it must ask first. There are three permission levels:

- **allow**: the tool runs without asking.
- **ask**: the user is asked before the tool runs. With nobody to answer (`cn -p`), the call is refused.
- **exclude**: the tool is not offered to the model, and a call to it is refused.

The full decision model (rule order, strict `Bash`, modes, matching) is in [`spec/permissions.md`](../../spec/permissions.md). This file is a map of the code.

## Default Policies

The defaults live in one table in `defaultPolicies.ts`, with a column for each kind of run. In short:

- Read-only tools (`Read`, `List`, `Search`, `Diff`, ...) are **allowed**.
- Write tools (`Edit`, `MultiEdit`, `Write`) **ask**.
- A few tools are open in the TUI and closed in headless mode, because nobody is there to approve them:

| Tool                      | TUI       | Headless                                   |
| ------------------------- | --------- | ------------------------------------------ |
| `Bash`                    | **ask**   | **allow**, but only for read-only commands |
| `Fetch`, `UploadArtifact` | **allow** | **exclude**                                |
| `Subagent`, MCP, others   | **ask**   | **exclude**                                |

`--readonly` (plan mode) never allows the write tools and keeps `Bash` to read-only commands, whatever the flags say.

A new built-in tool needs a row in `defaultPolicies.ts`. When unsure, make the headless default **exclude**.

## How It Works

### 1. Offering tools

Before each model request, only the tools that can be used are sent. A tool is offered when a call to it can run, or when someone is present to approve it. Excluded tools are never shown to the model.

### 2. Checking each call

Every tool call is checked by `checkToolPermission`:

- **allow**: the tool runs.
- **exclude**: the call is cancelled with `Command blocked by security policy`. A headless run gets a longer message that points at `--allow`, and ends.
- **ask**: the user is asked (step 3).

`Bash` calls also go through the `terminal-security` evaluator, which can turn an **allow** into **ask**. See [Deciding a call](../../spec/permissions.md#deciding-a-call).

### 3. Asking the user

The request is shown in the TUI (`ToolPermissionSelector`), or sent to a `cn serve` client. The user can:

- **Continue**: approve this call once,
- **Continue + don't ask again**: approve and save a rule to `~/.continue/permissions.yaml`, or
- **No, and tell NextCLI what to do differently**: reject the call and stop, so the user can type new instructions.

A saved rule applies from the next call.

## Architecture

### Core Components

- **`types.ts`**: the rule type (`ToolPermissionPolicy`) and a session's rules (`ToolPermissions`)
- **`defaultPolicies.ts`**: the default rules for each kind of run
- **`toolPattern.ts`**: parses `Tool`, `Tool(glob)` and name globs like `github_*`
- **`precedenceResolver.ts`**: layers flags, `permissions.yaml` and the defaults in normal mode
- **`permissionChecker.ts`**: decides a call (`checkToolPermission`) and whether a tool is offered (`isToolOffered`)
- **`permissionsYamlLoader.ts`**: reads and creates `~/.continue/permissions.yaml`
- **`policyWriter.ts`**: decides and saves the rule for **don't ask again**
- **`permissionManager.ts`**: holds pending approval requests
- **`../services/ToolPermissionService.ts`**: builds a session's rules for the current mode, and rebuilds them on a mode switch or reload

### Data Flow

1. **Building rules**: `ToolPermissionService.buildPolicies` combines the flags, the agent file, `permissions.yaml` and the defaults.
2. **Offering**: `getRequestTools` (`stream/handleToolCalls.ts`) keeps the tools `isToolOffered` accepts.
3. **Checking**: `executeStreamedToolCalls` (`stream/streamChatResponse.helpers.ts`) calls `checkToolPermission` for each call.
4. **Asking**: `requestUserPermission` sends an **ask** to `toolPermissionManager`, which shows it in the UI or sends it to `cn serve`.
5. **Remembering**: **don't ask again** calls `rememberToolApproval` (`policyWriter.ts`), then `reloadPermissions`.

## Tests

`permissionMatrix.test.ts` is the behavior spec. Each row is a run setup, a tool call and the expected decision. A behavior change edits its rows in the same commit.

## Related docs

- Users: `docs/cli/tool-permissions/` and `docs/cli/modes/`
- Model: [`spec/permissions.md`](../../spec/permissions.md) and [`spec/modes.md`](../../spec/modes.md)

All of them change with the code; `.checks/documentation-freshness.md` checks this.
