#!/usr/bin/env node
// Runs every package's build, typecheck, lint and test commands and records
// the results as JSON, so each phase of the dependency upgrade can be compared
// with the state before it. Nothing here installs packages or edits lockfiles.
//
// Usage:
//   node scripts/regression/capture-baseline.mjs --label baseline
//   node scripts/regression/capture-baseline.mjs --label p1 --only core,gui
//
// Writes scripts/regression/results/<label>/summary.json plus raw reports
// and logs next to it. The folder is git-ignored: results are machine-specific.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const STEP_TIMEOUT_MS = 30 * 60 * 1000;

// Packages build first, in dependency order (same as the cli's
// build:local-deps script), so typechecks and tests don't see stale dist/.
const BUILD_ORDER = [
  "packages/config-types",
  "packages/fetch",
  "packages/llm-info",
  "packages/terminal-security",
  "packages/config-yaml",
  "packages/openai-adapters",
  "core",
];

/** Every check, by area. `report` names the machine-readable output kind. */
export function defineSteps(rep) {
  // `npx --no` fails instead of downloading a tool the package doesn't have.
  const vitest = (area, name, extra = []) => ({
    area,
    name,
    cmd: [
      "npx",
      "--no",
      "vitest",
      "run",
      ...extra,
      "--reporter=json",
      `--outputFile=${rep(area, name)}`,
    ],
    report: "tests",
  });
  const jest = (area, name, env = {}) => ({
    area,
    name,
    cmd: ["npx", "--no", "jest", "--json", `--outputFile=${rep(area, name)}`],
    env,
    report: "tests",
  });
  const eslint = (area, args) => ({
    area,
    name: "eslint",
    cmd: [
      "npx",
      "--no",
      "eslint",
      ...args,
      "-f",
      "json",
      "-o",
      rep(area, "eslint"),
    ],
    report: "eslint",
  });
  const tsc = (area, args = ["--noEmit"]) => ({
    area,
    name: "tsc",
    cmd: ["npx", "--no", "tsc", ...args],
    report: "tsc",
  });
  const vmModules = { NODE_OPTIONS: "--experimental-vm-modules" };

  return [
    ...BUILD_ORDER.map((area) => ({
      area,
      name: "build",
      cmd: ["npm", "run", "build"],
      report: "exit",
    })),

    tsc("core", ["-p", "./", "--noEmit"]),
    eslint("core", [".", "--ext", "ts"]),
    jest("core", "jest", vmModules),
    vitest("core", "vitest"),

    tsc("gui", ["-p", "./", "--noEmit"]),
    // Mirrors gui's `lint` script exactly, which passes no path.
    eslint("gui", ["--ext", "ts"]),
    vitest("gui", "vitest"),

    tsc("extensions/vscode", ["-p", "./", "--noEmit"]),
    eslint("extensions/vscode", ["src", "--ext", "ts"]),
    vitest("extensions/vscode", "vitest"),

    { ...tsc("extensions/cli"), name: "tsc" },
    eslint("extensions/cli", ["."]),
    vitest("extensions/cli", "vitest"),
    vitest("extensions/cli", "vitest-e2e", [
      "--config",
      "vitest.e2e.config.ts",
    ]),
    {
      area: "extensions/cli",
      name: "smoke",
      cmd: ["node", "smoke-test.mjs"],
      report: "exit",
    },

    tsc("packages/config-types"),
    tsc("packages/llm-info"),
    tsc("packages/fetch"),
    vitest("packages/fetch", "vitest"),
    tsc("packages/terminal-security"),
    vitest("packages/terminal-security", "vitest"),
    tsc("packages/config-yaml"),
    jest("packages/config-yaml", "jest", vmModules),
    tsc("packages/openai-adapters"),
    vitest("packages/openai-adapters", "vitest"),
    tsc("packages/continue-sdk/typescript"),
    jest("packages/continue-sdk/typescript", "jest", vmModules),
  ];
}

/** Counts from a jest --json or vitest json report (same shape). */
export function summarizeTests(report) {
  const failing = [];
  for (const file of report.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      if (t.status === "failed") {
        failing.push(`${path.relative(ROOT, file.name)} > ${t.fullName}`);
      }
    }
    // A file that fails to load has no assertions but still failed.
    if (file.status === "failed" && !(file.assertionResults ?? []).length) {
      failing.push(`${path.relative(ROOT, file.name)} (suite failed to run)`);
    }
  }
  return {
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0),
    suitesFailed: report.numFailedTestSuites,
    failing: failing.sort(),
  };
}

/** Error/warning totals and per-rule hit counts from `eslint -f json`. */
export function summarizeEslint(results) {
  const rules = {};
  let errors = 0;
  let warnings = 0;
  for (const file of results) {
    errors += file.errorCount;
    warnings += file.warningCount;
    for (const m of file.messages) {
      const id = m.ruleId ?? "(parse error)";
      rules[id] = (rules[id] ?? 0) + 1;
    }
  }
  const sorted = Object.fromEntries(
    Object.entries(rules).sort(([a], [b]) => a.localeCompare(b)),
  );
  return { files: results.length, errors, warnings, rules: sorted };
}

/** Number of distinct TypeScript errors in tsc output. */
export function summarizeTsc(output) {
  return { errors: (output.match(/error TS\d+/g) ?? []).length };
}

function parseArgs(argv) {
  const opts = { label: "baseline", only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--label") opts.label = argv[++i];
    else if (argv[i] === "--only") opts.only = argv[++i].split(",");
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!/^[\w.-]+$/.test(opts.label)) throw new Error("Bad --label");
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.join(ROOT, "scripts/regression/results", opts.label);
  const rawDir = path.join(outDir, "raw");
  mkdirSync(rawDir, { recursive: true });

  const slug = (area, name) => `${area.replaceAll("/", "_")}.${name}`;
  const rep = (area, name) => path.join(rawDir, `${slug(area, name)}.json`);

  const steps = defineSteps(rep).filter(
    (s) => !opts.only || opts.only.some((o) => s.area.startsWith(o)),
  );
  const summaryFile = path.join(outDir, "summary.json");
  // With --only, rerun those steps and keep the rest of an earlier run.
  const previous =
    opts.only && existsSync(summaryFile)
      ? JSON.parse(readFileSync(summaryFile, "utf8"))
      : null;
  const summary = {
    label: opts.label,
    startedAt: previous?.startedAt ?? new Date().toISOString(),
    node: process.version,
    steps: previous?.steps ?? [],
  };
  const record = (entry) => {
    const i = summary.steps.findIndex(
      (s) => s.area === entry.area && s.name === entry.name,
    );
    if (i >= 0) summary.steps[i] = entry;
    else summary.steps.push(entry);
    writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n");
  };

  for (const step of steps) {
    const started = Date.now();
    process.stdout.write(`[${step.area}] ${step.name} ... `);
    // A package whose dependencies were never installed can't be checked;
    // record that instead of letting npx fetch tools for it. npx only looks
    // in the package's own node_modules/.bin.
    if (!existsSync(path.join(ROOT, step.area, "node_modules", ".bin"))) {
      console.log("skipped (dependencies not installed)");
      record({
        area: step.area,
        name: step.name,
        command: step.cmd.join(" "),
        skipped: "dependencies not installed",
      });
      continue;
    }
    const res = spawnSync(step.cmd[0], step.cmd.slice(1), {
      cwd: path.join(ROOT, step.area),
      env: { ...process.env, CI: "true", FORCE_COLOR: "0", ...step.env },
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: STEP_TIMEOUT_MS,
    });
    const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
    writeFileSync(
      path.join(rawDir, `${slug(step.area, step.name)}.log`),
      output,
    );

    const entry = {
      area: step.area,
      name: step.name,
      command: step.cmd
        .map((a) => (a.startsWith(rawDir) ? path.basename(a) : a))
        .join(" "),
      exitCode: res.status,
      timedOut: res.error?.code === "ETIMEDOUT",
      durationMs: Date.now() - started,
    };
    try {
      if (step.report === "tests" || step.report === "eslint") {
        const file = rep(step.area, step.name);
        if (!existsSync(file)) {
          entry.result = { error: "no report written; see the log" };
        } else {
          const data = JSON.parse(readFileSync(file, "utf8"));
          entry.result =
            step.report === "tests"
              ? summarizeTests(data)
              : summarizeEslint(data);
        }
      } else if (step.report === "tsc") {
        entry.result = summarizeTsc(output);
      }
    } catch (err) {
      entry.result = { error: `could not read report: ${err.message}` };
    }

    const r = entry.result;
    const detail =
      r?.error ??
      (r && "passed" in r
        ? `${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped`
        : r && "rules" in r
          ? `${r.errors} errors, ${r.warnings} warnings`
          : r && "errors" in r
            ? `${r.errors} TS errors`
            : "");
    console.log(
      `exit ${entry.exitCode}${entry.timedOut ? " (timed out)" : ""} ` +
        `${(entry.durationMs / 1000).toFixed(0)}s ${detail}`,
    );
    // Written after every step, so an interrupted run keeps partial results.
    record(entry);
  }

  summary.finishedAt = new Date().toISOString();
  writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n");
  console.log(`\nWrote ${path.relative(ROOT, outDir)}/summary.json`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
