// Run with: node --test scripts/ci/affected.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { computeAffected, loadGraph, testArgs } from "./affected.mjs";

// A fixed graph so the tests don't change when package.json files do.
const graph = {
  areas: {
    core: "core",
    gui: "gui",
    vscode: "extensions/vscode",
    cli: "extensions/cli",
    binary: "binary",
    "packages/config-types": "packages/config-types",
    "packages/config-yaml": "packages/config-yaml",
    "packages/fetch": "packages/fetch",
    "packages/llm-info": "packages/llm-info",
  },
  deps: {
    core: ["packages/config-types", "packages/config-yaml", "packages/fetch"],
    gui: ["core", "packages/config-yaml"],
    vscode: ["core", "gui", "packages/config-types"],
    cli: ["core", "packages/config-yaml"],
    binary: ["core"],
    "packages/config-types": [],
    "packages/config-yaml": ["packages/config-types"],
    "packages/fetch": ["packages/config-types"],
    "packages/llm-info": [],
  },
};

const run = (files, extra = {}) => computeAffected({ files, graph, ...extra });

test("docs-only change runs no jobs", () => {
  const r = run(["README.md", "docs/guide.mdx", "extensions/cli/spec/tui.md"]);
  assert.equal(r.docsOnly, true);
  assert.equal(r.full, false);
  for (const job of ["core", "gui", "vscode", "vscodeE2e", "cli", "binary"]) {
    assert.equal(r[job], false, job);
  }
  assert.deepEqual(r.packages, []);
});

test("CLI-only change runs only the CLI, with narrowed tests", () => {
  const r = run(["extensions/cli/src/ui/App.tsx"]);
  assert.equal(r.cli, true);
  assert.equal(r.cliCrossOs, true);
  assert.equal(r.core || r.gui || r.vscode || r.binary, false);
  assert.equal(r.testMode.cli, "changed");
  assert.equal(
    testArgs(r, "cli", "abc").vitest,
    "--changed abc --passWithNoTests",
  );
});

test("core change runs all its dependents with full suites", () => {
  const r = run(["core/llm/index.ts"]);
  assert.equal(
    r.core && r.gui && r.vscode && r.vscodeE2e && r.cli && r.binary,
    true,
  );
  assert.equal(r.testMode.core, "changed");
  assert.equal(r.testMode.gui, "full");
  assert.equal(r.testMode.cli, "full");
  // Only the CLI's own changes trigger Windows and macOS runs.
  assert.equal(r.cliCrossOs, false);
  assert.deepEqual(r.packages, []);
});

test("package change propagates through packages and apps", () => {
  const r = run(["packages/config-types/src/index.ts"]);
  assert.deepEqual(r.packages, ["config-types", "config-yaml", "fetch"]);
  assert.equal(r.core && r.gui && r.vscode && r.cli && r.binary, true);
  assert.equal(r.testMode.core, "full");
});

test("leaf package change stays local", () => {
  const r = run(["packages/llm-info/src/models.ts"]);
  assert.deepEqual(r.packages, ["llm-info"]);
  assert.equal(r.core, false);
});

test("GUI change affects the VS Code extension", () => {
  const r = run(["gui/src/App.tsx"]);
  assert.equal(r.gui && r.vscode && r.vscodeE2e, true);
  assert.equal(r.core || r.cli || r.binary, false);
});

test("e2e-only change runs the e2e matrix", () => {
  const r = run(["extensions/vscode/e2e/tests/GUI.test.ts"]);
  assert.equal(r.vscodeE2e, true);
});

test("test config change disables narrowing for that area", () => {
  const r = run(["core/jest.config.js", "core/llm/index.ts"]);
  assert.equal(r.testMode.core, "full");
  assert.deepEqual(testArgs(r, "core", "abc"), { jest: "", vitest: "" });
});

test("CI and lockfile changes force a full run", () => {
  for (const file of [
    "package-lock.json",
    ".nvmrc",
    ".github/workflows/ci.yml",
    ".github/actions/setup-packages/action.yml",
    "scripts/ci/affected.mjs",
  ]) {
    const r = run([file]);
    assert.equal(r.full, true, file);
    assert.equal(r.cliCrossOs && r.vscodeE2e, true, file);
    assert.equal(r.testMode.core, "full", file);
  }
});

test("requested full run selects everything", () => {
  const r = run([], { full: true, fullReason: "label ci:full" });
  assert.equal(r.full, true);
  assert.deepEqual(r.fullBy, ["label ci:full"]);
  assert.equal(r.packages.length, 4);
});

test("unmapped files only go through formatting", () => {
  const r = run([".github/workflows/cla.yaml", "eval/x.py"]);
  assert.equal(r.docsOnly, false);
  assert.equal(r.core || r.cli, false);
  assert.deepEqual(r.unmapped, [".github/workflows/cla.yaml", "eval/x.py"]);
});

test("loadGraph reads the real repository", () => {
  const real = loadGraph();
  assert.ok(real.deps.core.includes("packages/config-yaml"));
  assert.ok(real.deps.gui.includes("core"));
  assert.ok(real.deps.vscode.includes("gui"), "extra gui -> vscode edge");
  assert.ok(real.deps.cli.includes("core"));
  assert.ok(
    real.deps["packages/config-yaml"].includes("packages/config-types"),
  );
});
