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

### 1. Tool Filtering (Exclude Policy)

Tools with "exclude" permission are filtered out before being sent to the AI model. This means the AI won't even know these tools exist.

### 2. Permission Checking (Ask Policy)

When the AI tries to use a tool with "ask" permission, the system will:

1. Display a permission request in the UI
2. Wait for user approval (y/n)
3. Execute the tool if approved, or return an error if denied

### 3. Automatic Execution (Allow Policy)

Tools with "allow" permission are executed immediately without user intervention.

## Architecture

### Core Components

- **`types.ts`**: Defines the permission policy types and interfaces
- **`defaultPolicies.ts`**: Contains the hardcoded default permission policies
- **`permissionChecker.ts`**: Implements the permission checking logic
- **`permissionManager.ts`**: Manages permission requests and user responses
- **UI Components**: Handle displaying permission requests and collecting user input

### Data Flow

1. **Tool Loading**: `getAllowedTools()` in `streamChatResponse.ts` filters out excluded tools
2. **Tool Execution**: Before executing each tool call, permissions are checked
3. **User Interaction**: For "ask" policies, UI displays permission request
4. **Execution**: Tool is executed or denied based on permission result

## UI Integration

The permission system integrates with the existing chat UI:

- Permission requests appear as special message types
- Users can approve/deny with y/n keys
- The decision is shown in the chat history
- The system handles the async nature of permission requests

## Future Enhancements

The system is designed to be extensible for future features like:

- Custom permission policies loaded from configuration
- "Remember this decision" functionality
- Argument-based permission matching (partially implemented)
- Per-session or per-project permission overrides

## Example Usage

```typescript
// Check permission for a tool call
const result = checkToolPermission({
  name: "writeFile",
  arguments: { path: "/important.txt", content: "data" },
});

if (result.permission === "ask") {
  // Request user permission
}
```
