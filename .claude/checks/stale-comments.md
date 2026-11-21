---
name: Stale Comments
description: Flag comments that no longer match the code they describe
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.mjs"
---

Review comments in the lines this pull request changed, and comments directly above or inside functions whose code it changed. A misleading comment is worse than none. Flag:

- Inline or block comments that describe behavior the code no longer has, for example "retry on failure" above a single call with no retry.
- JSDoc `@param`, `@returns` or `@throws` that don't match the current signature: renamed or removed parameters, changed return type.
- `TODO`, `FIXME` or `HACK` comments whose described work the surrounding code already does.
- Commented-out code with a note saying it is still needed, when its replacement is right below it.

For each issue, suggest the corrected comment, or deleting it.

Ignore license headers, generated or vendored code, and comments in tests that describe intentionally wrong input.
