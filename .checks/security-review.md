---
name: Security Review
description: Catch security issues specific to a coding agent that runs on the user's machine
paths:
  - "core/**"
  - "extensions/**"
  - "gui/src/**"
  - "packages/**"
  - "binary/**"
---

NextCLI runs locally with the user's permissions. It reads their files, runs shell commands, and sends file contents to model providers. Review only code changed in this pull request. Flag:

- Content from files, web pages, tool results or model output that can reach a shell command, file write, or tool call without passing through the permission checks in `packages/terminal-security` or the tool permission policy in `extensions/cli/src/permissions/`. This is the prompt-injection path: a malicious repository or web page instructing the agent.
- New tools, or changes to existing tools, that run commands or write files without asking the user when the current permission mode requires it.
- Shell commands built by string concatenation from untrusted input instead of argument arrays.
- File paths from untrusted input used without resolving them and checking they stay inside the workspace (`../` traversal, symlinks).
- API keys, OAuth tokens or other credentials logged, written to telemetry, included in error messages shown to the model, or stored outside the existing secret storage.
- Hardcoded API keys, tokens or connection strings.
- New network calls to hosts the user did not configure, especially ones that send file contents or identifiers.
- Webview code in `gui/` or `extensions/vscode/` that renders model or file content as HTML without sanitizing it.

Do not flag test files, fixtures, or code that only moved without changing behavior.
