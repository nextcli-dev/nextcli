---
name: Anti-slop
description: Flag code patterns that add ceremony without adding behavior
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

Review only the code this pull request adds or changes. Flag patterns that make it longer or harder to read without changing what it does:

- Comments that restate the next line of code.
- Defensive checks, `try`/`catch` blocks or validation for cases the types or callers already rule out.
- Helper functions, classes or files for a one-line operation used once.
- Interfaces with one implementation, or factories that build one thing, added in this pull request.
- Variables assigned once and used on the next line only to name a step.
- Copy-pasted error handling that could be one shared path.
- JSDoc that only repeats the function signature.
- Unused parameters, dead branches, or options nothing passes.

Suggest the shorter version for each. Only flag clear cases, at most five, most significant first. Pass when nothing clearly qualifies.
