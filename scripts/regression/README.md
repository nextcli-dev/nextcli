# Regression fixtures from the dependency upgrade

Output recorded from libraries before the dependency upgrade replaced them, so
the replacements can be checked against it. Only output that can't be
recreated once a library is removed is committed.

| Fixture                                              | Records                                                                                                                                                     | Checked by                                                                                                                                                                                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/test/fixtures/regression/adf/golden.json`      | adf-to-md's Markdown for 35 Jira documents (recorded by `generate-adf-fixture.mjs`, in git history)                                                         | `adfToMarkdown.vitest.ts`                                                                                                                                                                                                                                                 |
| `core/test/fixtures/regression/database/golden.json` | dbinfoz's table schemas from SQLite, Postgres and MySQL, with the schema SQL that seeded each (recorded by `generate-database-fixture.mjs`, in git history) | `database.vitest.ts`: SQLite always; server engines with `database/compose.yaml` running and `NEXTCLI_DB_TESTS=1`, plus `DBINFOZ_DIR` (an install of dbinfoz@0.14.0) to compare with dbinfoz live. CI's `database-regression.yml` does this for Postgres, MySQL and MSSQL |
| `core/test/fixtures/regression/html/golden.json`     | Text the @url provider extracts from web pages                                                                                                              | `core/test/regression/htmlExtraction.vitest.ts`; `UPDATE_REGRESSION_FIXTURES=1` re-records                                                                                                                                                                                |

Data that can be rebuilt is not committed; tests build it at runtime. The
SQLite file format doesn't depend on the driver, so tests create old-schema
databases (dev data before `tokens_prompt`, the autocomplete cache, `shop` from
the schema SQL in `database/golden.json`) with the current one.

The upgrade also used a baseline script, `capture-baseline.mjs`, that recorded
every package's build, typecheck, lint and test results before and after each
phase. It was removed once the upgrade finished, because CI runs the same
checks on every pull request; it is in git history. The Phase 0 numbers are in
a comment on [PR #41](https://github.com/nextcli-dev/nextcli/pull/41).
