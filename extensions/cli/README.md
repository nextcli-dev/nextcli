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

Headless mode doesn't need a terminal (TTY). When you pass a prompt, it never reads stdin or starts the interactive UI, so it also works when the VS Code extension calls it as a terminal command.

#### What a headless run can do

Nobody is there to approve a tool, so a headless run is **closed by default**. With no flags:

- **Runs:** reading, searching and listing files, and shell commands the CLI can tell are read-only, such as `ls`, `cat`, `grep`, `git status` and `git diff`.
- **Refused:** everything else. That includes writing files; `Fetch`, `UploadArtifact`, `Subagent` and MCP tools; and every other shell command, such as `cp`, `mv`, `tee`, `curl`, `npm install`, `npm test`, `make`, `cargo`, a redirect to a file, a read outside the workspace or a script.

When the model calls a refused tool, the run ends and prints the answer so far. Your `~/.continue/permissions.yaml` can only take tools away here: its `exclude` rules apply, its `allow` rules don't.

Turn on what a run needs with `--allow`:

```bash
cn -p "Summarize https://example.com/changelog" --allow Fetch
cn -p "Fix the failing test" --allow Edit --allow "Bash(npm test*)"
cn -p "Update the API docs" --allow "Write(docs/**)" --allow "Edit(docs/**)"
cn -p "Triage the open issues" --allow "github_*"   # one MCP server's tools
cn -p "Set up the project" --allow "*"              # everything
```

`--auto` is not the same as `--allow "*"`. It allows writes, `Fetch` and MCP tools, but keeps Bash read-only and ignores `--allow`.

> **Breaking change:** `cn -p` scripts that used Bash, Fetch or MCP tools without flags now need `--allow`.

See [tool permissions](../../docs/cli/tool-permissions/index.mdx) for the details.

#### Commands that never run

Even with `--allow Bash`, two kinds of command are refused:

- Commands that would destroy the system, a home directory or a disk (`rm -rf /`, `rm -rf ~`, `find / -delete`, `wipefs -a`). These never run, in any mode.
- Broad deletes, such as a top-level directory (`/tmp`) or a path the CLI can't resolve (`rm -rf $DIR`). These need a person: the interactive CLI asks first, and headless mode refuses them.

These checks read the command text, so they are best-effort: a command can always hide what it deletes. For untrusted prompts or repositories, run `cn -p` in a container or sandbox, and prefer `--readonly`.

#### Review untrusted code with `--readonly`

`cn -p --readonly` only reads, searches and lists. Use it to review untrusted code, such as a pull request in CI.

- It never writes files: `Edit`, `MultiEdit` and `Write` never run, whatever the flags say.
- Bash, `Fetch` and MCP tools are off. `--allow` can turn them on: `--allow "Bash(git log*)"`, `--allow Fetch`, `--allow "github_*"`.
- Even then, Bash runs only read-only commands. `--allow Bash` or `--allow "Bash(git *)"` still can't run `git push`, `cp` or `curl`.

#### Agent files

`--agent` loads a file whose `tools:` line replaces the default rules:

- Listed tools run without asking.
- Built-in tools that aren't listed are hidden.
- `permissions.yaml` is ignored.
- In a headless run, the file's Bash stays read-only unless you also pass `--allow Bash`.

#### `cn review`

The review worker gets the closed headless defaults plus `Edit`, `MultiEdit` and `Write`, so it can fix the changed files in its worktree. `--allow` flags are not passed to the worker.

#### Limits

`--max-turns`, `--max-session-tokens`, `--max-cost` and `--max-time` cap one run. Before a run hits a limit, the CLI makes one last model call and asks for a final answer from what the model has found so far, without calling tools. The call still lists the tools, so the provider can serve the conversation from its prompt cache; any tool call in it is dropped, never run. If it brings back no text, the CLI asks once more with no tools. So the run still ends with a result.

- **Turns, tokens and cost:** the last call is made when it is the last one allowed, or when the budget left falls below the reserve kept for the final answer. The reserve is at least 10% of the limit and at least twice the last call. For `--max-cost`, it is also at least the last call plus the estimated cost of the final answer, which can be more than twice the last call, so a run can wrap up earlier.
- **`--max-time <seconds>`:** the clock starts when `cn` starts. The last call is made when the time left is less than the last turn (its model call, tools and any compaction) plus 10% of the limit.
- **`--max-time` can run over.** The final call is still made past the deadline, and one slow call can run past the limit. If your script kills `cn` at a timeout, pass a `--max-time` about a minute shorter.
- **Exit code 3.** In headless mode, a run ended by a limit exits with code 3, and the answer is still on stdout. A run that is already over its turn, token or cost limit makes no more model calls, and also exits with code 3.
- **Cost summary.** With `--format json`, the last line on stderr summarizes the run. `priced` says how the cost was worked out:

  - `exact`: from the host's price table
  - `estimated`: from OpenRouter's price for the same model
  - `fallback`: at $1 / $2 per million input / output tokens

  When `--max-cost` is set and a price isn't `exact`, a warning line comes first.

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
- `cn review`: Run AI reviews on your changes
- `cn checks`: Show CI check statuses for a pull request
- `cn trust [folder]`: Trust a folder (default: this one), so its `.env` and `.continue/.env` load
- `cn untrust [folder]`: Stop trusting a folder, even if a parent folder is trusted
- `cn cleanup`: Delete the codebase index and @docs data that older versions left in `~/.continue/index`
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
