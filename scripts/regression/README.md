# Regression baseline for the dependency upgrade

Scripts that capture how nextcli behaves before deprecated dependencies are
replaced, so each phase of the upgrade can prove nothing changed.

| Script                                          | Records                                                                                                                                                                                                                                                                                                             | Run                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `capture-baseline.mjs`                          | Build, typecheck, lint and test results for every package → `results/<label>/summary.json`                                                                                                                                                                                                                          | Before a phase (`--label baseline`) and after it (`--label p1`, …); `--only core,gui` reruns some areas into an existing label |
| `generate-lancedb-fixture.mjs`                  | The SQLite side of a search index written by vectordb 0.4.20 (codebase vectors, and docs chunks in the Phase 4.5 backup table) plus the top-k results vectordb returned → `core/test/fixtures/regression/lancedb-legacy/`. The Lance tables are built in a temp folder and not committed (`--lance-dir` keeps them) | While vectordb is still installed                                                                                              |
| `generate-sqlite-fixtures.mjs`                  | Database files written by the native sqlite3 driver, plus schema and row-count snapshot → `core/test/fixtures/regression/sqlite/`                                                                                                                                                                                   | Once, while sqlite3 is still installed                                                                                         |
| `generate-adf-fixture.mjs`                      | adf-to-md's Markdown for 35 Jira documents → `core/test/fixtures/regression/adf/golden.json`                                                                                                                                                                                                                        | Once, while adf-to-md is still installed                                                                                       |
| `generate-database-fixture.mjs`                 | dbinfoz's table schemas from SQLite, Postgres, MySQL and MSSQL → `core/test/fixtures/regression/database/golden.json`                                                                                                                                                                                               | Once; start `database/compose.yaml` first                                                                                      |
| `core/test/regression/htmlExtraction.vitest.ts` | Text extracted from web pages by the docs indexer and the @url provider                                                                                                                                                                                                                                             | Runs with core's vitest; `UPDATE_REGRESSION_FIXTURES=1` re-records                                                             |

The fixture generators must run before the dependency they record is removed;
after that, the committed output is the reference. The `results/` folder is
git-ignored: baselines are machine-specific and stay on the machine that made them.
`summary.json` records every path relative to the repo root, so a result file can
be shared without exposing local paths. The reference numbers for the baseline
run are in a comment on [PR #41](https://github.com/nextcli-dev/nextcli/pull/41).

Known gaps in the baseline:

- MSSQL crashes under x86 emulation on Apple Silicon, so its schema output must
  be recorded on an x86 Linux machine.
- `packages/continue-sdk/typescript` (the SDK code and its jest tests) is not
  installed or tested anywhere, so its steps are recorded as skipped. CI's
  `packages (continue-sdk)` job only runs `npm ci` and an `echo` test script in
  the parent folder.
