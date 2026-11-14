# E2E Tests

Selenium tests of the extension in a real VS Code, through [vscode-extension-tester](https://github.com/redhat-developer/vscode-extension-tester) (ExTester). They cover only what needs a real VS Code: the webview, keyboard focus, commands, diffs in the editor, autocomplete. Logic belongs in the Vitest suites in `gui/`, `core/` and `src/`, which are faster and don't flake.

## Setup

When running e2e tests for the first time:

```bash
npm run e2e:all          # macOS
npm run e2e:all-non-mac  # elsewhere (no codesign)
```

## Run

Depending on what you changed:

- e2e test code or `test-continue*/config.*`: `npm run e2e:quick`
- extension code: `npm run e2e:recompile-extension`
- gui code: `npm run e2e:rebuild-gui`

`scripts/extest.js` runs each test file in its own VS Code instance and config, as CI does. Environment variables:

- `TEST_FILE=./e2e/_output/tests/GUI.test.js` runs one file; by default all of them run.
- `E2E_CONFIG=json|yaml|both` (default `both`) picks `test-continue/config.json`, `test-continue-yaml/config.yaml` or both.
- `E2E_REPEAT=N` runs each file and config N times, each in a fresh instance.

After each instance, the VS Code logs, ChromeDriver log and screenshots are copied to `e2e/artifacts/<file>-<config>-<time>/`, because the next launch wipes them. With `E2E_REPEAT` above 1, only failed runs keep that copy. CI uploads the same files when a job fails.

VS Code opens `e2e/fixture-workspace` with its default 1200×800 window, locally and in CI. `e2e/Baseline.ts` checks both before the first test.

## How the suite is built

- `selectors/`: functions that find elements
- `actions/`: functions that do something in VS Code or the GUI
- `tests/`: the tests
- `Baseline.ts`: imported by every test file. Before every test it resets VS Code to one state: the GUI hidden, in an empty new session, with no turn running and not in Edit mode, and no editors, dialogs or notifications open. A test sets up anything else it needs itself, such as the model, mode and files.

## Rules for tests

These rules come from failures this suite has had. ESLint enforces the first three in `e2e/` (`npm run lint`).

- **Import `before`, `beforeEach`, `after` and `afterEach` from `vscode-extension-tester`,** not mocha's globals. ExTester's versions take a screenshot when a hook fails.
- **Run commands with `GlobalActions.runCommand("<command id>")`,** never ExTester's `executeCommand`. That one presses Enter on whatever pick is highlighted when no label matches, so a wrong label runs a different command. `runCommand` clicks the pick with the exact label, or fails and lists the picks it saw. Built-in commands need their palette label in `BUILTIN_COMMAND_LABELS`; the extension's labels are read from `package.json`.
- **Await every WebDriver call, and never use `?.click()`.** A click that may not happen hides a missing element. Wait for the element, then click it.
- **Retry only reads.** `TestUtils.waitForSuccess` repeats a function until it passes, so wrap only lookups and checks in it. Never wrap a click, keystroke or command that may already have taken effect when it throws.
- **No fixed sleeps.** Don't fix a race with `TestUtils.waitForTimeout`. Wait for the state you need with `waitForSuccess`, and give it a description so a timeout says what was missing.
- **Check that something happened and that it ended as expected.** For example, an edit's diff appears, then the file on disk has the expected contents after accepting it. A check that is already true before the action proves nothing.
- **Use keystrokes only when the key is what's tested** (Cmd+I, Cmd+L, Tab). Otherwise run the command. Before a keystroke meant for the editor, focus it and check it has focus (`GlobalActions.focusEditor`).
- **Choose models and modes with `GUIActions.useModel` and `useMode`.** They select by exact name and read the result back.

A new or re-enabled test needs a green stress run before it counts as working: add the `e2e:stress` label to the pull request, then push. CI runs every file 20 times per config, inside the usual 12 jobs. Link the run in the pull request.

## When a test fails

1. Look at the artifacts:

   - the screenshot, whose file name has the hook or test name
   - `logs/<time>/window1/exthost/exthost.log` for the extension's output (in CI's upload, under `storage/settings/logs/`)
   - `chromedriver.log`

   Baseline's `afterEach` also logs which element had focus.

2. Reproduce with `TEST_FILE` and the failing config. Use `E2E_REPEAT` for a failure that only happens sometimes.
3. Fix the cause, in the product or the test. Don't skip the test to get a pull request merged.

Common causes:

- A `data-testid` on a React component instead of an HTML element doesn't reach the DOM.
- A test that passes with one config and fails with the other: check both `test-continue*/config.*` files.
- Something takes focus away: the GUI focuses its input when it loads, which closes an open palette or quick pick.

## How it connects to the LLM

Through the models in `test-continue/config.json` and `test-continue-yaml/config.yaml`. Provider `mock` is `MockLLM` (`core/llm/llms/Mock.ts`): its `chatStream` is a list of turns, each a list of messages, so in YAML a turn is `- - REPEAT_LAST_MSG`, not `- REPEAT_LAST_MSG`. Provider `test` is `TestLLM`, which answers `TEST_USER_MESSAGE_<n>` with `TEST_LLM_RESPONSE_<n>`.
