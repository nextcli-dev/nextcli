---
name: Tests
description: How tests in nextcli must be written so they catch regressions
alwaysApply: false
globs:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.vitest.ts"
  - "**/test/**"
  - "**/e2e/**"
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.vitest.ts"
  - "**/test/**"
  - "**/e2e/**"
---

# Tests

- **Prove it can fail.** Revert the code change a test covers and run it: it must fail. Say so in the PR's Tests section.
- **Go through the real entry point** a user or caller hits (the command, the tool, the exported function), not only a private helper fed hand-built input.
- **Cover every input form and a negative case:** relative and absolute paths, `~`, `file://`, Windows `\` and short names (`RUNNER~1`, compare through `realpath`), CRLF, the run modes that differ.
- **Assert the behavior, not the old implementation.** No matrices asserting that a new path equals the old one: they add lines without checking what a user gets.
- **Clean up.** Timers, listeners and subscriptions stop on unmount or teardown (`useElementSize` broke `gui` CI twice).
- **No sleeps or retries.** Wait for the state you need. Timing assertions leave room for slow Windows runners.
- **Don't pin catalog values.** Read a model's limit or price from the catalog in the test, or use a fixture. The weekly `sync-models` PR changes the snapshot.
- **e2e stays a thin smoke test** of what needs a real VS Code. Logic goes in the Vitest suites. A failing e2e test is fixed, never skipped or quarantined.
