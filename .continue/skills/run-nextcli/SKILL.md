---
name: run-nextcli
description: Build, run, and drive the nextcli CLI (cn) and the nextcli VS Code extension. Use when asked to run or start nextcli, or to confirm a change works in the real CLI or extension rather than the tests.
model: sonnet
effort: medium
---

# Run nextcli

Paths are relative to the nextcli repo root. Default to the CLI: changes in
`core/` and `packages/` are cheapest to check there.

## CLI (cn)

Build:

```bash
node ./scripts/build-packages.js   # only if packages/* changed
(cd extensions/cli && npm run build:bundle)
```

Don't add `--no-minify` (the "Debug CLI" launch task does, for source-level
debugging): it leaves a ~24 MB bundle in `dist/` that fails the CLI smoke
test's size check.

Run from the sandbox so the repo isn't touched:

```bash
cd manual-testing-sandbox
node ../extensions/cli/dist/cn.js --version   # smoke check: prints the version, exit 0
node ../extensions/cli/dist/cn.js -p "<prompt that exercises the change>"
```

`-p` runs one prompt non-interactively and exits; check the exit code and the
output. Only for changes to the interactive TUI: run `cn` under tmux and use
`send-keys` / `capture-pane`.

## VS Code extension (UI or extension-host changes only)

Build (same steps as the "Launch extension" launch task):

```bash
node ./scripts/build-packages.js
(cd extensions/vscode && node scripts/prepackage.js && npm run esbuild)
```

The build can rewrite `package-lock.json` files as a side effect. Revert any you
didn't mean to change (`git checkout -- '*package-lock.json'`).

Start the GUI dev server **before** launching. It is required: a
`--extensionDevelopmentPath` host runs in Development mode, and in that mode
the webview loads the GUI from `http://localhost:5173`, not the built
`gui/assets` (`ContinueGUIWebviewViewProvider.ts`). Without vite the chat panel
is blank. The launch task does this through `gui:dev`.

```bash
(cd gui && npm run dev)   # run in the background; leave it running
# wait until it serves:
until curl -sf -o /dev/null http://localhost:5173/src/main.tsx; do sleep 1; done
```

GUI edits then hot-reload without rebuilding. If the host was opened before
vite was up, run "Developer: Reload Window" in it.

Launch an Extension Development Host on the sandbox. `env -u
ELECTRON_RUN_AS_NODE` is required from an agent shell inside VS Code (without
it the editor runs as Node and exits), and the folder must be an absolute
path:

```bash
env -u ELECTRON_RUN_AS_NODE \
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --user-data-dir=/tmp/nc-vsc --remote-debugging-port=9333 \
  --extensionDevelopmentPath="$PWD/extensions/vscode" "$PWD/manual-testing-sandbox"
```

### With the user's config and keys

To test with the user's models without touching their data, copy the config
into a scratch home and point the editor at it. Keep `--user-data-dir` short:
the IPC socket path is limited to 103 characters.

```bash
P=/tmp/nc-home && rm -rf "$P" && mkdir -p "$P"
rsync -a --exclude index --exclude sessions --exclude logs --exclude dev_data \
  ~/.continue/ "$P/.continue/"                 # config.yaml, .env, permissions, rules
env -u ELECTRON_RUN_AS_NODE CONTINUE_GLOBAL_DIR="$P/.continue" \
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --user-data-dir="$P/ud" --extensions-dir="$P/ext" --remote-debugging-port=9333 \
  --extensionDevelopmentPath="$PWD/extensions/vscode" "$PWD/manual-testing-sandbox"
```

The CLI reads the same keys from `~/.continue/.env`, so a live provider check
is `node ../extensions/cli/dist/cn.js -p "..."` from the sandbox.

### Packaged VSIX (what users install)

Use this when the change is in packaging, activation or the built GUI.
`prepackage.js` copies `gui/dist` as it is: build the GUI first or the VSIX
ships a stale one (CI builds it; local runs don't).

```bash
node ./scripts/build-packages.js
(cd gui && npm run build)
(cd extensions/vscode && node scripts/prepackage.js && npm run package)
git checkout -- '*package-lock.json'
env -u ELECTRON_RUN_AS_NODE \
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --user-data-dir="$P/ud" --extensions-dir="$P/ext" \
  --install-extension extensions/vscode/build/nextcli-<version>.vsix
```

Then launch as above without `--extensionDevelopmentPath` (no vite needed).

### Before handing over

Check the webview loaded: `curl -s http://127.0.0.1:9333/json/list` lists a
`webview` target, and the extension host log (Output → NextCLI, or
`$P/ud/logs/*/window1/exthost/exthost.log`) shows no activation error. If you
can't confirm it, say so instead of reporting it works.

Don't script the GUI further. Tell the user the window is open, which folder
and profile it uses, and what to check, then stop.

## Stop when

- one representative command shows the expected result, or
- a build fails: report the first error verbatim and don't start fixing
  unrelated build problems.
