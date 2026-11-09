---
name: Dependency Audit
description: Review new or updated dependencies for risk
paths:
  - "**/package.json"
  - "**/package-lock.json"
  - "**/pyproject.toml"
  - "uv.lock"
---

Review only dependency changes in this pull request: `package.json` files, lockfiles and `pyproject.toml`. NextCLI runs unattended in other people's CI with access to their code and a provider key, so every new dependency is code that runs there. Flag:

- A new dependency that looks unmaintained (no release or commit in the last 12 months), deprecated, or flagged for a security issue. Suggest a maintained alternative or code already in the repository.
- A new dependency that duplicates one already used in the same package, for example a second HTTP client, schema validator or glob library.
- A dependency bumped across more than one major version without a note in the pull request description.
- A package added to `dependencies` that is only used by tests or the build, or the reverse.
- A new entry in `scripts/ci/deprecations-allowlist.json` without a reason, or a removed dependency whose allowlist entry was left behind.
- A new install script (`preinstall`, `postinstall`), a git or tarball URL instead of a registry version, or a lockfile change that doesn't match a `package.json` change.
- A new runtime dependency in `extensions/cli` that pulls in a large native or optional module. The CLI should stay small and auditable.

Do not flag version bumps within the same major version unless the changelog lists a breaking change. If nothing qualifies, return PASS.
