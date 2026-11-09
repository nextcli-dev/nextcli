---
name: Test Coverage
description: Ensure changed behavior has a test that would fail if it broke
paths:
  - "core/**"
  - "extensions/**"
  - "gui/src/**"
  - "packages/**"
---

Review only code changed in this pull request. Tests sit next to the source: `*.test.ts` (Jest in `core/`, Vitest elsewhere) and `*.vitest.ts` (Vitest in `core/`; new `core/` tests use this). Flag:

- A behavior change, new exported function, or new branch with no test that exercises it. Name the test file where it belongs and the case to add.
- A new or tightened guard, filter, permission rule or deny rule that is only tested for what it blocks. It also needs a test that walks a legitimate flow through it.
- A test that cannot fail: it only checks wording or source text, asserts on a mock it just set up, or has no assertion.
- A deleted test whose source code still exists, or a test skipped with `.skip` or `xit` without a reason.

Do not flag `*.d.ts` files, generated code, type-only changes, moved code with unchanged behavior, docs, or config. Do not ask for tests of trivial getters or re-exports. If the changed behavior is covered, return PASS.
