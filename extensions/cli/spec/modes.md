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

Planning mode that **overrides user permissions** to enforce read-only access. This mode prevents file modifications, regardless of user configuration.

- **Command-line flag:** `--readonly` (for backward compatibility)
- **UI Indicator:** `[plan]` shown in blue
- **Current directory:** Hidden to save space and focus on analysis
- **Permission override:** excludes write tools (Write, Edit, MultiEdit) first, so no flag can bring them back, and allows read tools (Read, Search, List, etc.)
- **Bash, Fetch and MCP tools:**
  - Interactive: Bash and MCP tools ask before every call, because they can change files. Fetch is allowed.
  - Headless (`cn -p --readonly`): Bash, Fetch and MCP tools are excluded. Unattended runs often read untrusted code, such as a pull request, with a provider key in the environment, so they get no shell and no way to send data out.
- **User flags:** `--allow` and `--exclude` apply after the write exclusions and before the plan defaults, so a read-only run can be given one scoped tool, for example `--allow "Bash(git log*)"` or `--allow "github_*"`. `--allow Write`, `--allow Edit`, `--allow Bash`, `--allow Fetch`, `--allow "*"` and a glob that matches those tools (`Bash*`, `**`) don't enable writing, the shell, the network or every MCP tool. `--ask` is ignored in headless mode. `permissions.yaml` is ignored.
- **`cn review`** runs in plan mode.

### `auto`

Auto mode that **completely overrides all user permissions** to allow everything without asking. This mode provides maximum automation by bypassing all permission policies and restrictions, regardless of user configuration.

- **Command-line flag:** `--auto` (starts in auto mode)
- **UI Indicator:** `[auto]` shown in green
- **Current directory:** Hidden to save space and focus on automation
- **Permission override:** **Absolute** - allows all tools with `*: allow` policy
- **User config ignored:** Any user `--exclude` flags are overridden - everything is allowed

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

**Mode policies completely override all other configurations** when in plan or auto mode:

**Plan and Auto modes:**

1. **Mode policies** (absolute override - ignores everything else)

**Normal mode only:**

1. Command-line overrides (`--allow`, `--ask`, `--exclude`)
2. Permission configuration from `permissions.yaml`
3. Default tool policies

### Mode-Specific Behaviors

- **normal**: No mode policies applied, uses existing user configuration; shows current directory
- **plan**: **Absolute override** - excludes write tools (Write, Edit), allows read tools (Read, Grep, LS) and Bash; hides current directory
- **auto**: **Absolute override** - allows all tools with `*: allow` policy; hides current directory
