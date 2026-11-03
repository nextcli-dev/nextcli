# README demo GIFs

`record.sh` regenerates the four GIFs in `extensions/vscode/media/readme/` that the extension README shows: `agent.gif`, `chat.gif`, `edit.gif` and `autocomplete.gif`.

It drives a real VS Code with [vscode-extension-tester](https://github.com/redhat-developer/vscode-extension-tester), the same harness as the e2e tests. Each scene runs in [gpt-fast](https://github.com/meta-pytorch/gpt-fast), the project the original Continue GIFs used, pinned to the commit the scenes' line numbers come from.

| Scene          | What it records                                                                     |
| -------------- | ----------------------------------------------------------------------------------- |
| `agent`        | Agent mode: "where is the key value cache?"                                         |
| `chat`         | Select `group_quantize_tensor_from_qparams` in `quantize.py`, ⌘L, ask for a summary |
| `edit`         | Select `find_multiple` in `model.py`, ⌘I, "improve variable names", accept the diff |
| `autocomplete` | Complete the `--max_seq_length` argument in `eval.py` and accept it with Tab        |

## Requirements

- macOS (the GIFs use macOS window chrome and ⌘ shortcuts)
- `npm install` done in `extensions/vscode`
- `ffmpeg`, [`uv`](https://docs.astral.sh/uv/), and `gh` (signed in) unless you pass `DEMO_VSIX`
- A model config, see below. Every scene calls the model, so a run costs a few requests.

## Model config

Create a directory with a `config.yaml` that has one model for chat, edit and autocomplete, plus a `.env` if the config uses secrets. Don't point it at `~/.continue`: only these two files are copied, into a temporary directory that is deleted afterwards.

```yaml
name: NextCLI Demo
version: 1.0.0
schema: v1
models:
  - name: Sonnet 5.5
    provider: openai
    model: claude-sonnet-5-5
    apiBase: https://api.example.com/v1
    apiKey: ${{ secrets.EXAMPLE_API_KEY }}
    # OpenAI-compatible gateways often don't serve /v1/completions, which Edit uses otherwise.
    env:
      useLegacyCompletionsEndpoint: false
    capabilities:
      - tool_use
    roles:
      - chat
      - edit
      - apply
      - autocomplete
```

The model name is visible in the GIFs.

## Run

From `extensions/vscode`:

```bash
DEMO_CONFIG_DIR=~/nextcli-demo-config e2e/demo/record.sh               # all four scenes
DEMO_CONFIG_DIR=~/nextcli-demo-config e2e/demo/record.sh chat edit     # some of them
```

A VS Code window opens for each scene. Don't use the keyboard or mouse while it records.

By default the script records the macOS VSIX from the latest stable VS Code GitHub release (`vscode-vX.Y.Z`). To record a local build instead, set `DEMO_VSIX=path/to/nextcli-darwin-arm64-x.y.z.vsix`.

The agent scene approves tool calls that only read (files, search, listings). If the model asks to run a terminal command or edit a file, the scene fails; run it again.

To keep the screenshots of each scene, for example to see why one failed, set `DEMO_FRAMES_DIR`.

The first run downloads VS Code and ChromeDriver into the gitignored `e2e/storage` (about 900 MB).

## Before committing

- Check each GIF: the model's answers differ between runs, so re-record any scene with an answer that doesn't fit.
- Releases up to 1.4.1 label the status bar item "Continue" (fixed in #17), and with slow models they show no autocomplete ghost text (fixed in #16). Record 1.4.2 or later.

## Files

- `record.sh`: sets up the project, extension, VS Code and config, then records and composes each scene
- `ReadmeDemo.test.ts`: drives VS Code for one scene and saves a screenshot per step with timestamps
- `compose.py`: adds the window frame, shadow and keystroke badges, compresses idle time and encodes the GIF
- `settings.json`: VS Code settings for the recording (dark theme, no minimap, Next Edit off)
