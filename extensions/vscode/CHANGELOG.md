# Changelog

## [1.6.5](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.6.4...vscode-v1.6.5) (2026-11-06)


### ⚠ BREAKING CHANGES

* **vscode:** NextCLI for VS Code now requires VS Code 1.101 or newer. Older VS Code (and forks based on it) stays on NextCLI 1.6.x.

### Features

* **vscode:** require VS Code 1.101 or newer ([d917259](https://github.com/nextcli-dev/nextcli/commit/d91725908e05d69404fa29af0776e02d76d13d72))

## [1.6.4](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.6.3...vscode-v1.6.4) (2026-11-06)


### Features

* **vscode:** announce the VS Code 1.101 minimum for NextCLI 1.8 ([#56](https://github.com/nextcli-dev/nextcli/issues/56)) ([d1e8e31](https://github.com/nextcli-dev/nextcli/commit/d1e8e31165a5535c6fd5e89a57a9bb02ce87fefe))


### Bug Fixes

* **core:** convert Jira ADF in-house and drop adf-to-md ([#55](https://github.com/nextcli-dev/nextcli/issues/55)) ([c821b22](https://github.com/nextcli-dev/nextcli/commit/c821b22ace4c14577201fa39ed36205861476348))
* **core:** log startChat and call the request hook once per chat request ([#53](https://github.com/nextcli-dev/nextcli/issues/53)) ([a26d7e8](https://github.com/nextcli-dev/nextcli/commit/a26d7e828788ea68989a5c83151b3b9e56f75058))
* **deps:** update security-flagged transitive packages ([#42](https://github.com/nextcli-dev/nextcli/issues/42)) ([98bf6ad](https://github.com/nextcli-dev/nextcli/commit/98bf6ad14d6dfd31779d6aebf0565e6ac3001249))

## [1.6.3](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.6.2...vscode-v1.6.3) (2026-11-05)


### Bug Fixes

* streaming-edit typing, unreadable dirs, adt:// roots, CLI warning, NextCLI attribution ([#38](https://github.com/nextcli-dev/nextcli/issues/38)) ([61df861](https://github.com/nextcli-dev/nextcli/commit/61df86123845e419d264d4b288f650aa15bb7e7c))

## [1.6.2](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.6.1...vscode-v1.6.2) (2026-11-04)


### Bug Fixes

* **vscode:** autocomplete works with DeepSeek and Mistral models served through gateways such as OneProvider, instead of failing with "Not found" ([5ac0cfa](https://github.com/nextcli-dev/nextcli/commit/5ac0cfa4986df5721571f04aebd56fe6b5a45085))
* **vscode:** Moonshot uses the configured API base, and defaults to api.moonshot.ai ([5ac0cfa](https://github.com/nextcli-dev/nextcli/commit/5ac0cfa4986df5721571f04aebd56fe6b5a45085))
* **vscode:** remove retired models from the model presets and defaults ([5ac0cfa](https://github.com/nextcli-dev/nextcli/commit/5ac0cfa4986df5721571f04aebd56fe6b5a45085))
* **vscode:** Thinking Off works on Claude Sonnet 5.5 and is no longer offered on Opus 5.5 and Fable 5.x, which reject it ([5ac0cfa](https://github.com/nextcli-dev/nextcli/commit/5ac0cfa4986df5721571f04aebd56fe6b5a45085))

## [1.6.1](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.6.0...vscode-v1.6.1) (2026-11-04)


### Bug Fixes

* **vscode:** keep the model menu open when opening Model, Thinking or Effort, so the model can be switched ([4a1aeeb](https://github.com/nextcli-dev/nextcli/commit/4a1aeeb395ca863cd2d235cfb361eca613aff691))
* **vscode:** show the model menu in the same font size as the rest of the chat input ([4a1aeeb](https://github.com/nextcli-dev/nextcli/commit/4a1aeeb395ca863cd2d235cfb361eca613aff691))

## [1.6.0](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.4.5...vscode-v1.6.0) (2026-11-04)


### Miscellaneous Chores

* **vscode:** release 1.6.0 and publish pre-releases to the Marketplace only ([15f2e5f](https://github.com/nextcli-dev/nextcli/commit/15f2e5faaa162854593fbb0926e6b6a36c98669a))

## [1.4.5](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.4.4...vscode-v1.4.5) (2026-11-04)


### Bug Fixes

* **core:** drop sampling params while thinking on Bedrock, and use the configured thinking budget ([e93f7d0](https://github.com/nextcli-dev/nextcli/commit/e93f7d028881adf93ac2128b4588dbae8abb2d57))
* **core:** list each vendor's own effort levels on OpenRouter ([e93f7d0](https://github.com/nextcli-dev/nextcli/commit/e93f7d028881adf93ac2128b4588dbae8abb2d57))
* **vscode:** judge hidden thinking per block, not by the selected model ([e93f7d0](https://github.com/nextcli-dev/nextcli/commit/e93f7d028881adf93ac2128b4588dbae8abb2d57))
* **vscode:** package a sqlite3 6.0.1 binary for Windows on ARM ([e93f7d0](https://github.com/nextcli-dev/nextcli/commit/e93f7d028881adf93ac2128b4588dbae8abb2d57))
* **vscode:** wait for saved model settings on the first send, and undo a failed save ([e93f7d0](https://github.com/nextcli-dev/nextcli/commit/e93f7d028881adf93ac2128b4588dbae8abb2d57))

## [1.4.4](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.4.3...vscode-v1.4.4) (2026-11-04)


### Features

* **cli:** Thinking off, hidden or shown in the /model menu, shared with VS Code ([c88441b](https://github.com/nextcli-dev/nextcli/commit/c88441b122a6e6ab518f2faf804076645563876c))
* **core:** per-model thinking, effort, fast and context settings checked against the live APIs ([c88441b](https://github.com/nextcli-dev/nextcli/commit/c88441b122a6e6ab518f2faf804076645563876c))
* **vscode:** model menu with Fast, Thinking (Off / Hidden / Shown), Effort and Context ([c88441b](https://github.com/nextcli-dev/nextcli/commit/c88441b122a6e6ab518f2faf804076645563876c))


### Bug Fixes

* **cli:** show Claude 4.6-4.8 reasoning on OpenRouter when thinking is shown ([c88441b](https://github.com/nextcli-dev/nextcli/commit/c88441b122a6e6ab518f2faf804076645563876c))
* **vscode:** offer Claude 5.5 models when adding an Anthropic model ([c88441b](https://github.com/nextcli-dev/nextcli/commit/c88441b122a6e6ab518f2faf804076645563876c))

## [1.4.3](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.4.2...vscode-v1.4.3) (2026-11-03)


### Bug Fixes

* **vscode:** rename the extension to "NextCLI: Bring Your Own Model AI Agent" for the Marketplace ([#22](https://github.com/nextcli-dev/nextcli/issues/22)) ([812d34e](https://github.com/nextcli-dev/nextcli/commit/812d34eb636b2dd22dc47b124e417a551dc46f90))

## [1.4.2](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.4.1...vscode-v1.4.2) (2026-11-03)


### Bug Fixes

* **vscode:** show NextCLI instead of Continue in the autocomplete status bar item ([#17](https://github.com/nextcli-dev/nextcli/issues/17)) ([26a9475](https://github.com/nextcli-dev/nextcli/commit/26a94753dd503ee5b6a36346e628a8117e6e12f3))
* **vscode:** stop autocomplete from dropping every other completion when Next Edit is off ([a1f7ca5](https://github.com/nextcli-dev/nextcli/commit/a1f7ca5789ed86229c5883536718dcdacb3c26be))
