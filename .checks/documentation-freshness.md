---
name: Documentation Freshness
description: Keep docs in sync when CLI flags, config or user-facing behavior change
paths:
  - "extensions/cli/src/**"
  - "core/config/**"
  - "packages/config-yaml/src/**"
  - "packages/terminal-security/src/**"
---

Review only code changed in this pull request. Flag user-facing changes whose documentation was not updated in the same pull request:

- A `cn` command, subcommand or flag was added, removed, renamed, or changed its default. Docs: `docs/cli/`, `extensions/cli/README.md`, and `extensions/cli/spec/`.
- A `config.yaml` key or its meaning changed. Docs: `docs/customize/` and `docs/reference/`.
- An environment variable was added or renamed, including the `CONTINUE_*` to `NEXTCLI_*` renames. Both names must be documented while the old one is still read.
- The default behavior of headless mode, `--readonly`, `cn review`, tool permissions or terminal command approval changed. Docs: `docs/cli/headless-mode.mdx`, `docs/cli/tool-permissions.mdx`, and `extensions/cli/src/permissions/README.md`.
- An existing doc page or README now describes behavior the code no longer has.

Name the doc file and the sentence that needs to change. Do not flag internal refactors, test-only changes, or log and error message wording. If the docs were already updated or nothing user-facing changed, return PASS.
