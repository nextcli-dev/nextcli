# e2e fixture workspace

The VS Code e2e tests open this folder as their workspace: the `e2e:test`
script passes it to ExTester with `--open_resource`.

It is kept apart from the NextCLI config directories the tests use
(`e2e/test-continue` and `e2e/test-continue-yaml`). Their sessions, index
and dev data would otherwise be workspace files that the agent and the
indexer see.

Tests write their own files here, for example `edit-fixtures/`. Git ignores
everything in this folder except this README, and `scripts/extest.js`
removes those files before each VS Code instance starts.
