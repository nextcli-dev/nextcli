#!/usr/bin/env node
// Builds report.md from one or more results.jsonl files: one table per
// context window (and per variant label when files hold several), one row per
// task, each cell "median / mean" over the repetitions.
//
//   node eval/context/report.mjs results/a/results.jsonl results/b/results.jsonl
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : 0;
};

const fmt = (n, digits = 0) =>
  n >= 10000
    ? `${(n / 1000).toFixed(0)}k`
    : Number(n.toFixed(digits)).toLocaleString("en-US");

const COLUMNS = [
  ["compactions", (r) => r.compactions, 1],
  ["input tokens", (r) => r.inputTokens, 0],
  ["cached", (r) => r.cachedTokens, 0],
  ["cache write", (r) => r.cacheWriteTokens, 0],
  [
    "hit %",
    (r) => (r.inputTokens ? (100 * r.cachedTokens) / r.inputTokens : null),
    0,
  ],
  ["prefix breaks", (r) => r.prefixBreaks, 1],
  ["output", (r) => r.outputTokens, 0],
  ["cost $", (r) => r.costUsd, 3],
  ["wall s", (r) => r.wallMs / 1000, 0],
  [
    "recall %",
    (r) => (r.recallTotal ? (100 * r.recallCorrect) / r.recallTotal : null),
    0,
  ],
  ["re-reads", (r) => r.rereads, 1],
  ["over window", (r) => r.overWindow, 1],
];

function cell(runs, pick, digits) {
  const values = runs.map(pick).filter((v) => typeof v === "number");
  if (values.length === 0) return "n/a";
  return `${fmt(median(values), digits)} / ${fmt(mean(values), digits)}`;
}

function table(runs) {
  const head = [
    "task",
    "runs",
    "success",
    "limit",
    "loops",
    ...COLUMNS.map((c) => c[0]),
  ];
  const rows = [head, head.map(() => "---")];
  const byTask = Map.groupBy(runs, (r) => r.task);
  for (const [task, group] of [...byTask].sort((a, b) => a[0] - b[0])) {
    const count = (pred) => group.filter(pred).length;
    const errors = count((r) => r.error);
    rows.push([
      `${task} ${group[0].taskName}`,
      errors ? `${group.length} (${errors} failed to run)` : group.length,
      `${count((r) => r.success)}/${group.length}`,
      count((r) => r.limitReached),
      // Loops need the request files (NEXTCLI_TRACE=full, adapters that
      // write them); without them a run has no loop count
      group.some((r) => typeof r.loop === "boolean")
        ? count((r) => r.loop === true)
        : "n/a",
      ...COLUMNS.map(([, pick, digits]) => cell(group, pick, digits)),
    ]);
  }
  return rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}

export function buildReport(runs) {
  const out = ["# Context eval report", ""];
  out.push(
    `${runs.length} runs. Cells are median / mean over the repetitions. "limit" counts runs that ended on a --max-* limit (exit 3), "loops" runs that repeated an identical tool call 4 times or more. \`n/a\` means the trace had no tool arguments (run with --trace full).`,
    "",
  );
  const labels = [...new Set(runs.map((r) => r.label ?? "default"))];
  const windows = [...new Set(runs.map((r) => r.window))].sort((a, b) => a - b);
  for (const window of windows) {
    for (const label of labels) {
      const group = runs.filter(
        (r) => r.window === window && (r.label ?? "default") === label,
      );
      if (group.length === 0) continue;
      out.push(
        `## Window ${window.toLocaleString("en-US")} tokens, ${label} (${group[0].model})`,
        "",
      );
      out.push(table(group), "");
      const probeCost = group.reduce((s, r) => s + (r.probeCostUsd ?? 0), 0);
      out.push(
        `The recall probes are not in the metrics above; they cost $${probeCost.toFixed(3)} in total.`,
        "",
      );
    }
  }
  return out.join("\n");
}

function readRuns(files) {
  return files.flatMap((file) =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );
}

export function writeReport(resultFiles, outFile) {
  fs.writeFileSync(outFile, buildReport(readRuns(resultFiles)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: node eval/context/report.mjs <results.jsonl>...");
    process.exit(2);
  }
  console.log(buildReport(readRuns(files)));
}
