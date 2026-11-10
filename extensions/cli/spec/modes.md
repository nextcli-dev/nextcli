# Modes

Modes are a system for managing tool permissions in the CLI. They can be set via command-line flags at startup or switched dynamically during chat sessions. The following modes are available:

## Available Modes

### `normal` (default)

The default mode that follows configured permission policies from `permissions.yaml` and command-line overrides without any additional restrictions or mode-specific policies.

- **UI Indicator:** No indicator shown (clean interface for default behavior)
- **Current directory:** Visible in status bar for context
- **Permission behavior:** Uses existing permission policies as configured
- **Backward compatibility:** Existing configurations work unchanged

### `plan`

Planning mode uses only its own policies, to enforce read-only access. It prevents file modifications, whatever the flags, agent file or `permissions.yaml` say.

- **Command-line flag:** `--readonly` (for backward compatibility)
- **UI Indicator:** `[plan]` shown in blue
- **Current directory:** Hidden to save space and focus on analysis
- **Permission override:** **Absolute** - excludes write tools (Write, Edit, etc.) and allows read tools (Read, Search, List, etc.)
- **Bash, Fetch and MCP tools:**
  - Interactive: Bash and MCP tools ask before every call, because they can change files. Fetch is allowed.
  - Headless (`cn -p --readonly`): Bash, Fetch and MCP tools are excluded. Unattended runs often read untrusted code, such as a pull request, with a provider key in the environment, so they get no shell and no way to send data out.
- **User config ignored:** Any user `--allow` flags are overridden

### `auto`

Auto mode allows every tool without asking. With an agent file, the agent file's tool list still applies, with command-line flags on top (see [Mode Policy Priority](#mode-policy-priority)).

- **Command-line flag:** `--auto` (starts in auto mode)
- **UI Indicator:** `[auto]` shown in green
- **Current directory:** Hidden to save space and focus on automation
- **Without an agent file:** allows all tools with a `*: allow` policy. `permissions.yaml` and `--allow`/`--ask`/`--exclude` flags are ignored.
- **With an agent file:** flags first, then the agent file's tool list, as in normal mode.

## Usage

### Command-Line Initialization

Modes can be set when starting the CLI:

```bash
cn --readonly "Help me analyze this code"  # Starts in plan mode
cn --auto "Fix all the linting errors"     # Starts in auto mode
cn "Let me implement this feature"         # Starts in normal mode (default)
```

### Dynamic Mode Switching

Users can switch modes during chat sessions using:

**Keyboard Shortcut:**

- **Shift+Tab** - Cycle through modes: normal → plan → auto → (repeat)

## Implementation

Modes are implemented through the permission system:

- **ToolPermissionService**: Rectifies current mode and tool policies
- **ModeIndicator**: UI component showing current mode (hidden for normal mode)
- **Keyboard shortcuts**: Shift+Tab cycles through modes instantly
- **Backward compatibility**: Existing `--readonly` flag maps to plan mode

### Mode Policy Priority

The first rule that matches a call decides it. The rules come from, in order:

**Plan mode:** only the plan-mode policies. Flags, the agent file and `permissions.yaml` are ignored.

**With an agent file (normal and auto modes):**

1. Command-line overrides (`--allow`, `--ask`, `--exclude`)
2. The agent file's tool list

**Auto mode without an agent file:** `*: allow`. Flags and `permissions.yaml` are ignored.

**Normal mode without an agent file:**

1. Command-line overrides (`--allow`, `--ask`, `--exclude`)
2. Permission configuration from `permissions.yaml`
3. Default tool policies

Initialization, a mode switch and a permissions reload all build the policies the same way.

### Mode-Specific Behaviors

- **normal**: No mode policies applied, uses existing user configuration; shows current directory
- **plan**: excludes write tools (Write, Edit, MultiEdit) and allows read tools (Read, Search, List); Bash and MCP tools ask (excluded in a headless run); hides current directory
- **auto**: allows all tools, or applies the agent file's list when there is one; hides current directory
