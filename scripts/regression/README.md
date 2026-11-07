# Regression baseline for the dependency upgrade

Scripts that capture how nextcli behaves before deprecated dependencies are
replaced, so each phase of the upgrade can prove nothing changed.

| Script                                          | Records                                                                                                                                                     | Run                                                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `capture-baseline.mjs`                          | Build, typecheck, lint and test results for every package → `results/<label>/summary.json`                                                                  | Before a phase (`--label baseline`) and after it (`--label p1`, …); `--only core,gui` reruns some areas into an existing label |
| `generate-adf-fixture.mjs` (removed)            | adf-to-md's Markdown for 35 Jira documents → `core/test/fixtures/regression/adf/golden.json`; `adfToMarkdown.vitest.ts` checks the replacement against it   | Ran once before Phase 3 removed adf-to-md; the script is in git history                                                        |
| `generate-database-fixture.mjs`                 | dbinfoz's table schemas from SQLite, Postgres, MySQL and MSSQL, with the schema SQL that seeded each → `core/test/fixtures/regression/database/golden.json` | Once; start `database/compose.yaml` first                                                                                      |
| `core/test/regression/htmlExtraction.vitest.ts` | Text extracted from web pages by the docs indexer and the @url provider                                                                                     | Runs with core's vitest; `UPDATE_REGRESSION_FIXTURES=1` re-records                                                             |

Only output that can't be recreated once a library is removed is committed:
what adf-to-md, dbinfoz and today's HTML extraction produce. The generators must
run before the dependency they record is removed; after that, the committed
output is the reference.

Data that can be rebuilt is not committed; the phase's tests build it at
runtime:

- **Databases** (Phase 6): the SQLite file format doesn't depend on the driver,
  so tests create old-schema databases (devdata before `tokens_prompt`, the
  autocomplete cache, `shop` from the schema SQL in `database/golden.json`) with
  whichever driver is current.

The `results/` folder is git-ignored: baselines are machine-specific and stay on
the machine that made them. `summary.json` records every path relative to the
repo root, so a result file can be shared without exposing local paths. The
reference numbers for the baseline run are in a comment on
[PR #41](https://github.com/nextcli-dev/nextcli/pull/41).

Known gaps in the baseline:

- MSSQL crashes under x86 emulation on Apple Silicon, so its schema output must
  be recorded on an x86 Linux machine.
- `packages/continue-sdk/typescript` (the SDK code and its jest tests) is not
  installed or tested anywhere, so its steps are recorded as skipped. CI's
  `packages (continue-sdk)` job only runs `npm ci` and an `echo` test script in
  the parent folder.
