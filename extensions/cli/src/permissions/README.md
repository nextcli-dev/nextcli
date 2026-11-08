# Tool Permissions System

The tool permissions system allows you to control which tools the AI can use and how it can use them. There are three permission levels:

- **allow**: The tool will be executed automatically without asking for permission
- **ask**: The tool will prompt the user for permission before execution
- **exclude**: The tool will be filtered out entirely and won't be available to the AI

## Default Policies

The system comes with sensible default policies:

- Read-only tools (`Read`, `List`, `Search`, `Diff`, ...) are **allowed** by default
- Write operations (`Edit`, `MultiEdit`, `Write`) require **confirmation** (ask)
- `Bash`, `Fetch`-in-headless and MCP tools differ between the TUI and headless mode:

| Tool                   | TUI       | Headless (nobody to approve)                                                                                                      |
| ---------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Bash`                 | **ask**   | **allow** only for commands the evaluator approves on its own (`ls`, `cat`, `git status`...), otherwise **ask**, which is refused |
| `Fetch`                | **allow** | **exclude**                                                                                                                       |
| MCP and any other tool | **ask**   | **exclude**                                                                                                                       |

Any `ask` in a headless run is refused, because nobody can answer it. Policies carry a `source`: the defaults are tagged `"default"`, and a default `allow` for a tool that judges its own calls (Bash) is narrowed with the tool's strict evaluation (`checkToolPermission`). A policy without a source is the operator's (`--allow`, or a `permissions.yaml` rule the run kept) and is taken as given. In a headless run, `permissions.yaml` keeps its excludes and the safe remembered allows (`headlessKeepsYamlPolicy`): a scoped pattern such as `Bash(ls*)`, or a whole tool headless does not close, such as `Write`. Asks are dropped, and so are whole-tool Bash, Fetch, `*`, and MCP names. The file is per machine, so an exclude written for the terminal also removes that tool from `cn -p`. Opt in to more with `--allow`.

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
