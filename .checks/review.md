---
name: Review
description: Find correctness bugs in the code a pull request changes
paths:
  - "core/**"
  - "extensions/**"
  - "gui/src/**"
  - "packages/**"
---

Review only code changed in this pull request. Report bugs that would make the code behave wrongly, most important first. Flag:

- Logic errors: wrong conditions, off-by-one, inverted checks, wrong operator or default.
- Error paths that are unhandled, swallowed, or leave state half-updated.
- Races and ordering problems: missing `await`, shared state changed across async calls, listeners or timers never cleaned up.
- Wrong use of an API: wrong argument order, wrong return type assumed, behavior that differs between Node versions or platforms.
- Callers or implementers of a changed function, type or config key that the change leaves broken.
- New behavior with no test that would fail if it broke.

Do not flag style, naming, formatting, or code that only moved without changing behavior. Do not flag test files except for a test that cannot fail. If you find nothing, return PASS.
