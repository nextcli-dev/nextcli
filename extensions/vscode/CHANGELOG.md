# Changelog

## [1.6.15](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.6.14...vscode-v1.6.15) (2026-11-13)


### Bug Fixes

* **llm-info:** match every DeepSeek V4 model id ([#136](https://github.com/nextcli-dev/nextcli/issues/136)) ([cf8b0ec](https://github.com/nextcli-dev/nextcli/commit/cf8b0ec9ad01b9ae94164238b2fbb3aacc2905b2))

## [1.6.14](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.6.13...vscode-v1.6.14) (2026-11-12)


### ⚠ BREAKING CHANGES

* **cli:** in a folder you haven't trusted, the project's .env no longer loads. Proxy and CA variables must come from the environment.

### Features

* **cli:** load a folder's .env only if the folder is trusted ([#126](https://github.com/nextcli-dev/nextcli/issues/126)) ([ac43c9e](https://github.com/nextcli-dev/nextcli/commit/ac43c9ee2db5e53ea08ce33b04e234aa987c682e))
* **cli:** strip secrets from the shell's environment and block private addresses in Fetch ([#123](https://github.com/nextcli-dev/nextcli/issues/123)) ([58db692](https://github.com/nextcli-dev/nextcli/commit/58db692eaa1ce21af14d61429a11fff6ebe14610))


### Bug Fixes

* **core:** name colocated rules.md by workspace-relative path ([#133](https://github.com/nextcli-dev/nextcli/issues/133)) ([1ee49bb](https://github.com/nextcli-dev/nextcli/commit/1ee49bb3884e5dacd98c06b0f1fd514f716da288))
* keep CRLF line endings when editing files ([#131](https://github.com/nextcli-dev/nextcli/issues/131)) ([bb4343d](https://github.com/nextcli-dev/nextcli/commit/bb4343d4838c738f0fc34d99138778dc6f0e3139))
* **vscode:** edit files by absolute and Windows paths ([#130](https://github.com/nextcli-dev/nextcli/issues/130)) ([0c781f3](https://github.com/nextcli-dev/nextcli/commit/0c781f30c3300fac94d67c2c79760affed977a29))

## [1.6.13](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.6.12...vscode-v1.6.13) (2026-11-11)


### Bug Fixes

* **vscode:** explain turns that end on thinking alone and restyle reasoning ([#120](https://github.com/nextcli-dev/nextcli/issues/120)) ([caf7763](https://github.com/nextcli-dev/nextcli/commit/caf77632a06c7f88173a7f74315ba71439598dbf))

## [1.6.12](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.6.11...vscode-v1.6.12) (2026-11-10)


### ⚠ BREAKING CHANGES

* **cli:** close the headless defaults; unattended runs no longer offer MCP tools, Fetch, UploadArtifact, Subagent, or Bash commands beyond read-only ones (ls, cat, git status...), so scripts that used them need --allow, for example --allow Fetch, --allow "Bash(npm test*)" or --allow "github_*" ([#115](https://github.com/nextcli-dev/nextcli/issues/115))
* **cli:** Bash(pattern) rules match each command in the line: an exclude covers chained, wrapped and sh -c commands, an allow covers only a single command ([#109](https://github.com/nextcli-dev/nextcli/issues/109))
* **cli:** --allow, --ask and --exclude take Tool(pattern) like permissions.yaml, and a pattern on a tool that takes none is an error ([#109](https://github.com/nextcli-dev/nextcli/issues/109))

### Features

* **cli:** --readonly applies --allow and --exclude, never runs Edit, MultiEdit or Write, and keeps Bash read-only whatever the flags say ([#115](https://github.com/nextcli-dev/nextcli/issues/115)) ([0b6fb3e](https://github.com/nextcli-dev/nextcli/commit/0b6fb3ed458c956ec384eae10f265a635a20338f))
* **cli:** a headless run takes only the excludes from permissions.yaml ([#115](https://github.com/nextcli-dev/nextcli/issues/115)) ([0b6fb3e](https://github.com/nextcli-dev/nextcli/commit/0b6fb3ed458c956ec384eae10f265a635a20338f))
* **cli:** close the headless defaults; unattended runs no longer offer MCP tools, Fetch, UploadArtifact, Subagent, or Bash commands beyond read-only ones (ls, cat, git status...), so scripts that used them need --allow, for example --allow Fetch, --allow "Bash(npm test*)" or --allow "github_*" ([#115](https://github.com/nextcli-dev/nextcli/issues/115)) ([0b6fb3e](https://github.com/nextcli-dev/nextcli/commit/0b6fb3ed458c956ec384eae10f265a635a20338f))
* **cli:** cn review no longer runs in auto mode; it gets Edit, MultiEdit and Write plus the closed defaults ([#115](https://github.com/nextcli-dev/nextcli/issues/115)) ([0b6fb3e](https://github.com/nextcli-dev/nextcli/commit/0b6fb3ed458c956ec384eae10f265a635a20338f))
* make /init create AGENTS.md or update the existing agent file ([#119](https://github.com/nextcli-dev/nextcli/issues/119)) ([1e10559](https://github.com/nextcli-dev/nextcli/commit/1e1055961ee077abb987b891742b1cf60e37f080))
* **terminal-security:** add splitCommand and a strict evaluation mode ([#108](https://github.com/nextcli-dev/nextcli/issues/108)) ([483fcd9](https://github.com/nextcli-dev/nextcli/commit/483fcd934fa94b93f166f1f9179374c09ff577ac))


### Bug Fixes

* **cli:** --allow and --exclude apply on top of an agent file ([#109](https://github.com/nextcli-dev/nextcli/issues/109)) ([88985e6](https://github.com/nextcli-dev/nextcli/commit/88985e6d07a14fddf5183dfc1ce93e5fa90a7073))
* **cli:** --allow, --ask and --exclude take Tool(pattern) like permissions.yaml, and a pattern on a tool that takes none is an error ([#109](https://github.com/nextcli-dev/nextcli/issues/109)) ([88985e6](https://github.com/nextcli-dev/nextcli/commit/88985e6d07a14fddf5183dfc1ce93e5fa90a7073))
* **cli:** --readonly with an agent file stays read-only, and an agent file's exclusions still apply in auto mode ([#109](https://github.com/nextcli-dev/nextcli/issues/109)) ([88985e6](https://github.com/nextcli-dev/nextcli/commit/88985e6d07a14fddf5183dfc1ce93e5fa90a7073))
* **cli:** "don't ask again" no longer remembers a wrapper, a shell or a chain as a Bash rule ([#109](https://github.com/nextcli-dev/nextcli/issues/109)) ([88985e6](https://github.com/nextcli-dev/nextcli/commit/88985e6d07a14fddf5183dfc1ce93e5fa90a7073))
* **cli:** a permissions reload keeps the agent file, the command line flags and headless mode ([#109](https://github.com/nextcli-dev/nextcli/issues/109)) ([88985e6](https://github.com/nextcli-dev/nextcli/commit/88985e6d07a14fddf5183dfc1ce93e5fa90a7073))
* **cli:** a subagent runs under the parent session's permissions and can't start another subagent ([#115](https://github.com/nextcli-dev/nextcli/issues/115)) ([0b6fb3e](https://github.com/nextcli-dev/nextcli/commit/0b6fb3ed458c956ec384eae10f265a635a20338f))
* **cli:** Bash(pattern) rules match each command in the line: an exclude covers chained, wrapped and sh -c commands, an allow covers only a single command ([#109](https://github.com/nextcli-dev/nextcli/issues/109)) ([88985e6](https://github.com/nextcli-dev/nextcli/commit/88985e6d07a14fddf5183dfc1ce93e5fa90a7073))
* **cli:** cn serve tool calls can be approved through POST /permission again ([#115](https://github.com/nextcli-dev/nextcli/issues/115)) ([0b6fb3e](https://github.com/nextcli-dev/nextcli/commit/0b6fb3ed458c956ec384eae10f265a635a20338f))
* **cli:** scoped rules in permissions.yaml match the tool's real argument, so exclude: [Read(.env*)] excludes .env ([#109](https://github.com/nextcli-dev/nextcli/issues/109)) ([88985e6](https://github.com/nextcli-dev/nextcli/commit/88985e6d07a14fddf5183dfc1ce93e5fa90a7073))
* **terminal-security:** NodeNext tsconfig; docs(cli): headless defaults ([#116](https://github.com/nextcli-dev/nextcli/issues/116)) ([7497064](https://github.com/nextcli-dev/nextcli/commit/7497064239487302de74d511af0a3a0970f0d41d))

## [1.6.11](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.6.10...vscode-v1.6.11) (2026-11-08)


### Bug Fixes

* **cli:** make the final answer at --max-cost reliable ([#92](https://github.com/nextcli-dev/nextcli/issues/92)) ([ab7300a](https://github.com/nextcli-dev/nextcli/commit/ab7300aa0db2093060d2770c1a88c37e8b0c5490))

## [1.6.10](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.6.9...vscode-v1.6.10) (2026-11-08)


### Bug Fixes

* **vscode:** load the README images from raw.githubusercontent.com ([#89](https://github.com/nextcli-dev/nextcli/issues/89)) ([53b8cc7](https://github.com/nextcli-dev/nextcli/commit/53b8cc78515960cb19d8a579e6681ff15b62661e))

## [1.6.9](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.6.8...vscode-v1.6.9) (2026-11-07)


### Features

* **cli:** a run that reaches --max-turns, --max-session-tokens or --max-cost returns a final answer without tools and exits 3 ([#82](https://github.com/nextcli-dev/nextcli/issues/82)) ([aaa01d9](https://github.com/nextcli-dev/nextcli/commit/aaa01d95cb3364b20f7ff935ffcca87b92cb7363))
* **cli:** headless --readonly no longer offers Bash, Fetch or MCP tools, including when an agent file is loaded ([#82](https://github.com/nextcli-dev/nextcli/issues/82)) ([aaa01d9](https://github.com/nextcli-dev/nextcli/commit/aaa01d95cb3364b20f7ff935ffcca87b92cb7363))
* **core:** price oneprovider and OpenRouter models from their own tables, so --max-cost no longer relies on the $1/$2 fallback ([#82](https://github.com/nextcli-dev/nextcli/issues/82)) ([aaa01d9](https://github.com/nextcli-dev/nextcli/commit/aaa01d95cb3364b20f7ff935ffcca87b92cb7363))
* offer to delete legacy index data; remove the baseline script and JetBrains code ([#79](https://github.com/nextcli-dev/nextcli/issues/79)) ([6c99f66](https://github.com/nextcli-dev/nextcli/commit/6c99f663b823fcc7491c5a271cf1a5c212e0dcb1))


### Bug Fixes

* **core:** publish index.sqlite only after tag_catalog exists, so index setup no longer fails after a corrupt database ([#82](https://github.com/nextcli-dev/nextcli/issues/82)) ([aaa01d9](https://github.com/nextcli-dev/nextcli/commit/aaa01d95cb3364b20f7ff935ffcca87b92cb7363))

## [1.6.8](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.6.7...vscode-v1.6.8) (2026-11-07)


### ⚠ BREAKING CHANGES

* NextCLI needs VS Code 1.103 or newer. On VS Code 1.101 and 1.102 it stays on 1.6.7; on 1.70 to 1.100 on 1.6.4.

### Features

* move core's SQLite to node:sqlite and require VS Code 1.103 ([#71](https://github.com/nextcli-dev/nextcli/issues/71)) ([e8f50c3](https://github.com/nextcli-dev/nextcli/commit/e8f50c390e63ba02a1bc1e5c585f70617f0432ec))
* replace dbinfoz and remove sqlite3 ([#74](https://github.com/nextcli-dev/nextcli/issues/74)) ([dafdec3](https://github.com/nextcli-dev/nextcli/commit/dafdec37ae768a884ef2497661361ae64a3f3c74))

## [1.6.7](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.6.6...vscode-v1.6.7) (2026-11-07)


### ⚠ BREAKING CHANGES

* Embeddings-based search, @docs and the `codebase` tool are removed. @codebase and @folder use keyword search only. A model with the `embed` role, `embeddingsProvider` and `docs` config entries are ignored with a warning. For documentation, use the fetch tool or a docs MCP server such as Context7.

### Features

* remove embeddings, LanceDB and [@docs](https://github.com/docs) ([#62](https://github.com/nextcli-dev/nextcli/issues/62)) ([fc3576e](https://github.com/nextcli-dev/nextcli/commit/fc3576eda8c57c9810d6657220b36469666c198a))


### Bug Fixes

* **core:** give the docs provider and docs block their own warnings ([#70](https://github.com/nextcli-dev/nextcli/issues/70)) ([96eb165](https://github.com/nextcli-dev/nextcli/commit/96eb1652edfe427651475563d9166255ae709116))

## [1.6.6](https://github.com/nextcli-dev/nextcli/compare/vscode-v1.6.5...vscode-v1.6.6) (2026-11-07)


### Features

* **core:** add opt-in OpenTelemetry metrics ([e0cb5e6](https://github.com/nextcli-dev/nextcli/commit/e0cb5e6006d7ee226a3b3961be3d0a2cdf7a7623))


### Bug Fixes

* close the model menu after a pick; stub jsdom's sync-XHR worker ([#66](https://github.com/nextcli-dev/nextcli/issues/66)) ([6fbc6ee](https://github.com/nextcli-dev/nextcli/commit/6fbc6ee060a16f990187def646ac3034361dcd28))
* **core:** make the telemetry opt-in work and the exporter stoppable ([bcb9926](https://github.com/nextcli-dev/nextcli/commit/bcb9926b1659a8ae5240f2d2f4569eee19910673))
* review follow-ups for Phase 4 and core telemetry ([#65](https://github.com/nextcli-dev/nextcli/issues/65)) ([1b67791](https://github.com/nextcli-dev/nextcli/commit/1b67791dbaff690c68fba1ab9ae0195d5dd3bf2b))
* **vscode:** state that 1.6.5 is the first release needing VS Code 1.101 ([f80bf0b](https://github.com/nextcli-dev/nextcli/commit/f80bf0baa30fd160e5b35f5d34c404585d076bb3))

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
