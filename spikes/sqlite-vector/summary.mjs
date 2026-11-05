#!/usr/bin/env node
// Turns check.mjs reports into a Markdown table for the CI run summary.
// Exits 1 if any report is missing or failed.
//
//   node spikes/sqlite-vector/summary.mjs <label>=<report.json> ...

import { existsSync, readFileSync } from "node:fs";

const cell = (check, text) =>
  !check
    ? "—"
    : check.ok
      ? `✅ ${text ?? ""}`.trim()
      : `❌ ${check.error ? check.error.split("\n")[0] : (text ?? "")}`.trim();

let failed = false;
const lines = [
  "| Runtime | Load | Retrieval (exact; quantized recall) | Search p50/p95 ms (exact; quantized; filtered exact; filtered quantized) | Recall@10 (quantized; filtered) | Concurrency |",
  "| --- | --- | --- | --- | --- | --- |",
];
for (const arg of process.argv.slice(2)) {
  const [label, file] = arg.split("=");
  if (!existsSync(file)) {
    failed = true;
    lines.push(`| ${label} | ❌ no report | | | | |`);
    continue;
  }
  const r = JSON.parse(readFileSync(file, "utf8"));
  failed ||= !r.ok;
  const { load, retrieval, performance: perf, concurrency } = r.checks;
  const ms = (m) => (m ? `${m.p50}/${m.p95}` : "—");
  const runtime = r.runtime.electron
    ? `${label}: Electron ${r.runtime.electron} (Node ${r.runtime.node})`
    : `${label}: Node ${r.runtime.node}`;
  lines.push(
    [
      runtime,
      cell(load, load && `SQLite ${load.sqlite}, vector ${load.vector}`),
      cell(
        retrieval,
        retrieval &&
          `${retrieval.exactQueriesChecked - retrieval.exactMismatches}/${retrieval.exactQueriesChecked} exact; ${retrieval.filteredQuantizedRecall}`,
      ),
      perf?.searchMs
        ? `${perf.chunks / 1000}k rows: ` +
          [
            perf.searchMs.exact,
            perf.searchMs.quantized,
            perf.searchMs.exactFiltered,
            perf.searchMs.quantizedFiltered,
          ]
            .map(ms)
            .join("; ")
        : cell(perf),
      perf?.recall
        ? cell(
            perf,
            `${perf.recall.quantized}; ${perf.recall.quantizedFiltered}`,
          )
        : "—",
      cell(
        concurrency,
        concurrency &&
          `${concurrency.rows?.A ?? 0}+${concurrency.rows?.B ?? 0} rows, ${concurrency.integrity}`,
      ),
    ]
      .join(" | ")
      .replace(/^/, "| ")
      .concat(" |"),
  );
}
console.log(lines.join("\n"));
process.exitCode = failed ? 1 : 0;
