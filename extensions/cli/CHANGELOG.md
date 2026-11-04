# Changelog

## [0.2.1](https://github.com/nextcli-dev/nextcli/compare/cli-v0.2.0...cli-v0.2.1) (2026-11-04)


### Bug Fixes

* **core:** drop sampling params while thinking on Bedrock, and use the configured thinking budget ([e93f7d0](https://github.com/nextcli-dev/nextcli/commit/e93f7d028881adf93ac2128b4588dbae8abb2d57))
* **core:** list each vendor's own effort levels on OpenRouter ([e93f7d0](https://github.com/nextcli-dev/nextcli/commit/e93f7d028881adf93ac2128b4588dbae8abb2d57))
* **vscode:** judge hidden thinking per block, not by the selected model ([e93f7d0](https://github.com/nextcli-dev/nextcli/commit/e93f7d028881adf93ac2128b4588dbae8abb2d57))
* **vscode:** package a sqlite3 6.0.1 binary for Windows on ARM ([e93f7d0](https://github.com/nextcli-dev/nextcli/commit/e93f7d028881adf93ac2128b4588dbae8abb2d57))
* **vscode:** wait for saved model settings on the first send, and undo a failed save ([e93f7d0](https://github.com/nextcli-dev/nextcli/commit/e93f7d028881adf93ac2128b4588dbae8abb2d57))

## [0.2.0](https://github.com/nextcli-dev/nextcli/compare/cli-v0.1.1...cli-v0.2.0) (2026-11-04)


### Features

* **cli:** Thinking off, hidden or shown in the /model menu, shared with VS Code ([c88441b](https://github.com/nextcli-dev/nextcli/commit/c88441b122a6e6ab518f2faf804076645563876c))
* **core:** per-model thinking, effort, fast and context settings checked against the live APIs ([c88441b](https://github.com/nextcli-dev/nextcli/commit/c88441b122a6e6ab518f2faf804076645563876c))
* **vscode:** model menu with Fast, Thinking (Off / Hidden / Shown), Effort and Context ([c88441b](https://github.com/nextcli-dev/nextcli/commit/c88441b122a6e6ab518f2faf804076645563876c))


### Bug Fixes

* **cli:** show Claude 4.6-4.8 reasoning on OpenRouter when thinking is shown ([c88441b](https://github.com/nextcli-dev/nextcli/commit/c88441b122a6e6ab518f2faf804076645563876c))
* **vscode:** offer Claude 5.5 models when adding an Anthropic model ([c88441b](https://github.com/nextcli-dev/nextcli/commit/c88441b122a6e6ab518f2faf804076645563876c))

## Changelog

Releases of `@nextcli/cli` are listed here. release-please updates this file from the conventional-commit titles of merged pull requests.

Earlier history, from before the fork, is in the [continuedev/cli changelog](https://github.com/continuedev/continue/blob/main/extensions/cli/CHANGELOG.md).
