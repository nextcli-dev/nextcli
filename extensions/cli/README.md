# NextCLI CLI

The NextCLI CLI (`cn`) is a customizable command line coding agent.

![NextCLI CLI Demo](https://raw.githubusercontent.com/nextcli-dev/nextcli/main/extensions/cli/media/demo.gif)

## Installation

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/nextcli-dev/nextcli/main/extensions/cli/scripts/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/nextcli-dev/nextcli/main/extensions/cli/scripts/install.ps1 | iex
```

Or install with npm if you have Node.js 22.15+:

```bash
npm i -g @nextcli/cli
```

## Usage

```bash
cn
```

### Headless Mode

Headless mode (`-p` flag) runs without an interactive terminal UI, making it perfect for:

- Scripts and automation
- CI/CD pipelines
- Docker containers
- VS Code extension integration
- Environments without a TTY

```bash
# Basic usage
cn -p "Generate a conventional commit name for the current git changes."

# With piped input
echo "Review this code" | cn -p

# JSON output for scripting
cn -p "Analyze the code" --format json

# Silent mode (strips thinking tags)
cn -p "Write a README" --silent
```

**TTY-less Environments**: Headless mode is designed to work in environments without a terminal (TTY), such as when called from the VS Code extension using terminal commands. The CLI will not attempt to read stdin or initialize the interactive UI when running in headless mode with a supplied prompt.

**Closed by default in headless mode**: nobody is there to approve a tool, so a headless run only gets what is safe without a person. Reading, searching and listing work. `Fetch`, `UploadArtifact`, `Subagent`, MCP tools and any other tool are excluded. `Bash` runs only commands the evaluator approves on its own, such as `ls`, `cat`, `grep`, `git status` and `git diff`. Every other command, including `cp`, `mv`, `tee`, `curl`, `npm install`, `npm test`, `make`, `cargo`, a redirect to a file, a read outside the workspace and any script, is refused, and so is any tool that would `ask`. A refused call ends the run with the answer so far. `~/.continue/permissions.yaml` contributes only its excludes. Opt in with `--allow`: `--allow Fetch`, `--allow "Bash(npm test*)"`, `--allow "Write(docs/**)"`, `--allow "github_*"` for an MCP server's tools, or `--allow "*"` for everything. `cn -p --auto` is not the same as `--allow "*"`: it opens writes, `Fetch` and MCP tools but keeps `Bash` read-only and ignores `--allow`. **Breaking:** `cn -p` scripts that used Bash, Fetch or MCP tools without flags now need `--allow`. See [tool permissions](../../docs/cli/tool-permissions/index.mdx).

**Command safety**: with `--allow Bash`, two kinds of command are still refused:

- Commands that would destroy the system, a home directory or a disk (`rm -rf /`, `rm -rf ~`, `find / -delete`, `wipefs -a`) never run, in any mode.
- Broad deletes (a top-level directory such as `/tmp`, a path the CLI can't resolve, such as `rm -rf $DIR`) need a person. The interactive CLI asks first; headless mode refuses them.

These checks read the command text, so they are best-effort: a command can always hide what it deletes. For untrusted prompts or repositories, run `cn -p` in a container or sandbox, and prefer `--readonly`.

**Read-only headless runs**: `cn -p --readonly` can't write files, run Bash, call MCP tools or use Fetch. It can only read, search and list. Use it to review untrusted code, such as a pull request in CI. `--allow` still applies: `--allow "Bash(git log*)"` adds that command, `--allow Fetch` adds fetching and `--allow "github_*"` adds that server. Two limits hold on every call whatever the flags say: `Edit`, `MultiEdit` and `Write` never run, and `Bash` runs only commands the evaluator approves on its own, so `--allow Bash` or `--allow "Bash(git *)"` still can't run `git push`, `cp` or `curl`.

**Agent files**: `--agent` loads a file whose `tools:` line replaces the default rules. Listed tools run without asking, unlisted built-in tools are hidden, and `permissions.yaml` is ignored. In a headless run the file's `Bash` is still read-only unless `--allow Bash` is passed.

**`cn review`**: the review worker edits the changed files in a worktree, so it gets `Edit`, `MultiEdit` and `Write` plus the closed headless defaults. `--allow` flags are not passed to the worker.

**Limits**: `--max-turns`, `--max-session-tokens` and `--max-cost` cap one run. When a run is about to reach a limit, the CLI makes one last model call without tools and asks for a final answer from what the model has found so far, so the run still ends with a result.

- The last call is made when it is the last allowed call, or when the budget left is less than twice the last call, with a minimum reserve of 10% of the limit.
- In headless mode, a run ended by a limit exits with code **3**. The answer is still on stdout. If the run is already over the limit, the CLI does not make another model call, and that also exits with code 3.
- With `--format json`, the last line on stderr summarizes the run. `priced` says how the cost was worked out: `exact` from the host's price table, `estimated` from OpenRouter's price for the same model, or `fallback` at $1 / $2 per million input / output tokens. When `--max-cost` is set and a price isn't exact, a warning line comes first.

```json
{
  "status": "limit",
  "limit": "cost",
  "usage": {
    "cost": 0.94,
    "priced": "exact",
    "promptTokens": 612000,
    "completionTokens": 33000
  }
}
```

### Session Management

The CLI automatically saves your chat history for each terminal session. You can resume where you left off:

```bash
# Resume the last session in this terminal
cn --resume

# List recent sessions and choose one to resume
cn ls

# List sessions in JSON format (for scripting)
cn ls --json
```

## Command Line Options

- `-p`: Run in headless mode (no TUI)
- `--config <path>`: Specify agent configuration path
- `--resume`: Resume the last session for this terminal
- `<prompt>`: Optional prompt to start with

## Environment Variables

- `CONTINUE_CLI_DISABLE_COMMIT_SIGNATURE`: Disable adding the Continue commit signature to generated commit messages
- `FORCE_NO_TTY`: Force TTY-less mode, prevents stdin reading (useful for testing and automation)

## Commands

- `cn`: Start an interactive chat session
- `cn ls`: List recent sessions with TUI selector to choose one to resume
- `cn login`: Authenticate with Continue
- `cn logout`: Sign out of current session
- `cn remote`: Launch a remote instance
- `cn serve`: Start HTTP server mode

### Session Listing (`cn ls`)

Shows recent sessions, limited by screen height to ensure it fits on your terminal.

- `--json`: Output in JSON format for scripting (always shows 10 sessions)

## TTY-less Support

The CLI fully supports running in environments without a TTY (terminal):

```bash
# From Docker without TTY allocation
docker run --rm my-image cn -p "Generate docs"

# From CI/CD pipeline
cn -p "Review changes" --format json

# From the VS Code extension terminal tool
cn -p "Analyze code" --silent
```

The CLI automatically detects TTY-less environments and adjusts its behavior:

- Skips stdin reading when a prompt is supplied
- Disables interactive UI components
- Ensures clean stdout/stderr output

For more details, see [`spec/tty-less-support.md`](./spec/tty-less-support.md).
