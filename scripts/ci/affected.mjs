#!/usr/bin/env node
// Decides which CI jobs a change needs, so a pull request only runs the checks
// it can affect. Used by .github/workflows/ci.yml; run it locally with
// `node scripts/ci/affected.mjs --base origin/main --explain`.
//
// How it decides:
// 1. Every changed file is mapped to an area (core, gui, vscode, cli,
//    or a package under packages/). Markdown and docs map to nothing.
// 2. Some files (lockfiles, CI config, shared tooling) force a full run.
// 3. Areas propagate to everything that depends on them. Dependencies are read
//    from each package.json: `file:` links and names of local packages.
// 4. Each area gets a test mode. "changed" narrows jest/vitest to tests that
//    import the changed files. That is only safe when the area's own files
//    changed and nothing it depends on did, because jest's import tracking
//    stops at the area's root. Every other affected area runs its full suite.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

// Areas that are not under packages/. The key is the area name used in the
// outputs; the value is its directory.
export const APP_AREAS = {
  core: "core",
  gui: "gui",
  vscode: "extensions/vscode",
  cli: "extensions/cli",
};

// Edges that package.json does not declare. The extension bundles the GUI
// build (extensions/vscode/scripts/prepackage), so a GUI change affects it.
const EXTRA_EDGES = { gui: ["vscode"] };

// Changes to these files can affect every job, so they force a full run.
const FULL_RUN_PATTERNS = [
  /^package(-lock)?\.json$/,
  /^\.nvmrc$/,
  /^\.node-version$/,
  /^\.eslintrc\.shared\.json$/,
  /^\.prettierrc$/,
  /^\.prettierignore$/,
  /^scripts\/build-packages\.js$/,
  /^scripts\/ci\//,
  /^\.github\/workflows\/ci\.yml$/,
  /^\.github\/actions\//,
];

// Files that never affect a build or test. They only go through prettier.
const DOCS_PATTERNS = [
  /\.md$/,
  /\.mdx$/,
  /^docs\//,
  /^docs-site\//,
  /^\.github\/ISSUE_TEMPLATE\//,
  /^\.github\/pull_request_template\.md$/,
  /^(LICENSE|NOTICE)$/,
];

// Inside an area, changes to these files change how its tests run, so the
// area runs its full suite instead of only the related tests.
const TEST_CONFIG_PATTERNS = [
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)(jest|vitest)[^/]*\.(c|m)?(js|ts)$/,
  /(^|\/)(jest|vitest|test)[.-]?setup[^/]*$/i,
  /(^|\/)\.eslintrc[^/]*$/,
  /(^|\/)(__mocks__|__fixtures__|fixtures|test-fixtures)\//,
];

// The e2e matrix also runs when only the e2e tests themselves change.
const E2E_PATTERN = /^extensions\/vscode\/e2e\//;

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// Returns { areas: {name: dir}, deps: {name: [names it depends on]} }.
export function loadGraph(rootDir = ROOT) {
  const areas = { ...APP_AREAS };
  const packagesDir = path.join(rootDir, "packages");
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        existsSync(path.join(packagesDir, entry.name, "package.json"))
      ) {
        areas[`packages/${entry.name}`] = `packages/${entry.name}`;
      }
    }
  }

  const byDir = new Map(
    Object.entries(areas).map(([name, dir]) => [dir, name]),
  );
  const byPackageName = new Map();
  const manifests = {};
  for (const [name, dir] of Object.entries(areas)) {
    const file = path.join(rootDir, dir, "package.json");
    if (!existsSync(file)) continue;
    manifests[name] = readJson(file);
    if (manifests[name].name) byPackageName.set(manifests[name].name, name);
  }

  const deps = {};
  for (const [name, manifest] of Object.entries(manifests)) {
    const all = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    };
    const found = new Set();
    for (const [depName, spec] of Object.entries(all)) {
      if (typeof spec === "string" && spec.startsWith("file:")) {
        const target = path
          .relative(rootDir, path.resolve(rootDir, areas[name], spec.slice(5)))
          .split(path.sep)
          .join("/");
        if (byDir.has(target)) found.add(byDir.get(target));
      } else if (byPackageName.has(depName)) {
        found.add(byPackageName.get(depName));
      }
    }
    found.delete(name);
    deps[name] = [...found].sort();
  }
  for (const [from, tos] of Object.entries(EXTRA_EDGES)) {
    for (const to of tos) {
      if (deps[to] && !deps[to].includes(from)) deps[to].push(from);
    }
  }
  return { areas, deps };
}

function areaOf(file, areas) {
  let best = null;
  for (const [name, dir] of Object.entries(areas)) {
    if (
      file.startsWith(`${dir}/`) &&
      (!best || dir.length > areas[best].length)
    ) {
      best = name;
    }
  }
  return best;
}

// Pure decision function. `files` are repo-relative paths with forward slashes.
export function computeAffected({ files, graph, full = false, fullReason }) {
  const { areas, deps } = graph;
  const reasons = {};
  const note = (area, why) => {
    (reasons[area] ??= []).push(why);
  };

  const direct = new Map(); // area -> changed files inside it
  const ignored = [];
  const unmapped = [];
  let fullBy = full ? [fullReason ?? "requested"] : [];
  let e2eFiles = [];

  for (const file of files) {
    if (FULL_RUN_PATTERNS.some((re) => re.test(file))) {
      fullBy.push(file);
      continue;
    }
    if (DOCS_PATTERNS.some((re) => re.test(file))) {
      ignored.push(file);
      continue;
    }
    if (E2E_PATTERN.test(file)) e2eFiles.push(file);
    const area = areaOf(file, areas);
    if (!area) {
      unmapped.push(file);
      continue;
    }
    if (!direct.has(area)) direct.set(area, []);
    direct.get(area).push(file);
  }

  const isFull = fullBy.length > 0;
  const affected = new Set();

  if (isFull) {
    for (const area of Object.keys(areas)) {
      affected.add(area);
      note(area, `full run (${fullBy.slice(0, 3).join(", ")})`);
    }
  } else {
    for (const [area, changed] of direct) {
      affected.add(area);
      note(
        area,
        `changed: ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ` (+${changed.length - 3})` : ""}`,
      );
    }
    // Propagate to dependents until nothing new is added.
    let grew = true;
    while (grew) {
      grew = false;
      for (const [area, areaDeps] of Object.entries(deps)) {
        if (affected.has(area)) continue;
        const via = areaDeps.find((d) => affected.has(d));
        if (via) {
          affected.add(area);
          note(area, `depends on ${via}`);
          grew = true;
        }
      }
    }
  }

  // Test mode per area: "changed" only when the area's own source changed,
  // none of its test config changed, and nothing it depends on is affected.
  const testMode = {};
  for (const area of affected) {
    const own = direct.get(area) ?? [];
    const depAffected = (deps[area] ?? []).some((d) => affected.has(d));
    const configChanged = own.some((f) =>
      TEST_CONFIG_PATTERNS.some((re) =>
        re.test(f.slice(areas[area].length + 1)),
      ),
    );
    testMode[area] =
      isFull || own.length === 0 || depAffected || configChanged
        ? "full"
        : "changed";
  }

  const has = (a) => affected.has(a);
  const packages = [...affected]
    .filter((a) => a.startsWith("packages/"))
    .map((a) => a.slice("packages/".length))
    .sort();

  return {
    full: isFull,
    fullBy,
    docsOnly: !isFull && affected.size === 0 && unmapped.length === 0,
    core: has("core"),
    gui: has("gui"),
    vscode: has("vscode"),
    vscodeE2e: has("vscode") || e2eFiles.length > 0,
    cli: has("cli"),
    // Windows and macOS CLI runs are the most expensive jobs. They run when
    // the CLI's own files change, or on a full run.
    cliCrossOs: isFull || direct.has("cli"),
    packages,
    testMode,
    reasons,
    ignored,
    unmapped,
  };
}

// jest and vitest arguments for an area. Empty means "run the full suite".
export function testArgs(result, area, base) {
  if (!base || result.testMode[area] !== "changed") {
    return { jest: "", vitest: "" };
  }
  return {
    jest: `--changedSince=${base} --passWithNoTests`,
    vitest: `--changed ${base} --passWithNoTests`,
  };
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function parseArgs(argv) {
  const opts = { explain: false, githubOutput: false, full: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base") opts.base = argv[++i];
    else if (arg === "--head") opts.head = argv[++i];
    else if (arg === "--files") opts.filesFrom = argv[++i];
    else if (arg === "--full") {
      opts.full = true;
      if (argv[i + 1] && !argv[i + 1].startsWith("--"))
        opts.fullReason = argv[++i];
    } else if (arg === "--explain") opts.explain = true;
    else if (arg === "--github-output") opts.githubOutput = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function explain(result) {
  const lines = [];
  lines.push(
    result.full
      ? `Full run: ${result.fullBy.join(", ")}`
      : result.docsOnly
        ? "Docs-only change: only formatting checks run."
        : "Selective run.",
  );
  lines.push("");
  lines.push("| Area | Tests | Why |");
  lines.push("| --- | --- | --- |");
  const areas = Object.keys(result.reasons).sort();
  for (const area of areas) {
    lines.push(
      `| ${area} | ${result.testMode[area]} | ${result.reasons[area].join("; ")} |`,
    );
  }
  if (areas.length === 0) lines.push("| (none) | | |");
  lines.push("");
  lines.push(
    `Jobs: ${
      ["core", "gui", "vscode", "vscodeE2e", "cli", "cliCrossOs"]
        .filter((k) => result[k])
        .join(", ") || "none"
    }; packages: ${result.packages.join(", ") || "none"}`,
  );
  if (result.unmapped.length) {
    lines.push("");
    lines.push(
      `Not mapped to any job (formatting only): ${result.unmapped.slice(0, 10).join(", ")}${result.unmapped.length > 10 ? " …" : ""}`,
    );
  }
  return lines.join("\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "Usage: node scripts/ci/affected.mjs [--base <ref>] [--head <ref>] [--files <file>] [--full [reason]] [--explain] [--github-output]",
    );
    return;
  }

  // `base` is what narrowed tests compare against. CI passes the PR's base
  // commit and runs on the merge commit, so the comparison covers exactly the
  // PR's changes. The file list uses the merge base, so commits that landed on
  // main after the branch was cut are not counted as the PR's changes.
  let files = [];
  const base = opts.full ? undefined : (opts.base ?? "origin/main");
  if (opts.filesFrom) {
    files = readFileSync(opts.filesFrom, "utf8").split("\n").filter(Boolean);
  } else if (!opts.full) {
    files = git(["diff", "--name-only", `${base}...${opts.head ?? "HEAD"}`])
      .split("\n")
      .filter(Boolean);
  }

  const graph = loadGraph();
  const result = computeAffected({
    files,
    graph,
    full: opts.full,
    fullReason: opts.fullReason,
  });

  if (opts.githubOutput) {
    const out = process.env.GITHUB_OUTPUT;
    if (!out) throw new Error("GITHUB_OUTPUT is not set");
    const args = (area) => testArgs(result, area, base);
    const values = {
      full: result.full,
      docs_only: result.docsOnly,
      core: result.core,
      gui: result.gui,
      vscode: result.vscode,
      vscode_e2e: result.vscodeE2e,
      cli: result.cli,
      cli_cross_os: result.cliCrossOs,
      packages: JSON.stringify(result.packages),
      base_sha: base ?? "",
      core_jest_args: args("core").jest,
      core_vitest_args: args("core").vitest,
      gui_vitest_args: args("gui").vitest,
      vscode_vitest_args: args("vscode").vitest,
      cli_vitest_args: args("cli").vitest,
    };
    appendFileSync(
      out,
      Object.entries(values)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(""),
    );
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Affected areas\n\n${explain(result)}\n`,
      );
    }
  }

  if (opts.explain || !opts.githubOutput) {
    console.log(
      opts.explain ? explain(result) : JSON.stringify(result, null, 2),
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
