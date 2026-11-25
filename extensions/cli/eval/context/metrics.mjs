// Reads what one run left behind: the NEXTCLI_TRACE files, the headless
// summary line on stderr, and the answers to the recall probes.
import fs from "node:fs";
import path from "node:path";

function readLines(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/** The JSON lines of every trace file in a folder (not its request folders) */
export function readTrace(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readLines(path.join(dir, name)));
}

function usageOf(attrs) {
  const u = attrs.usage ?? {};
  const cacheRead =
    u.prompt_tokens_details?.cached_tokens ??
    u.cache_read_input_tokens ??
    u.cached_tokens ??
    0;
  const input =
    u.prompt_tokens ??
    (u.input_tokens ?? 0) + cacheRead + (u.cache_creation_input_tokens ?? 0);
  return {
    input,
    cached: cacheRead,
    output: u.completion_tokens ?? u.output_tokens ?? 0,
  };
}

/** Request files NEXTCLI_TRACE=full wrote, in the order they were sent */
function readRequestFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of fs.readdirSync(path.join(dir, entry.name))) {
      const m = /^request-(\d+)\.json$/.exec(name);
      if (m)
        files.push({ n: Number(m[1]), file: path.join(dir, entry.name, name) });
    }
  }
  return files
    .sort((a, b) => a.n - b.n)
    .map(({ file }) => JSON.parse(fs.readFileSync(file, "utf8")));
}

/**
 * Every tool call that appears in a request body, in any provider's format
 * (OpenAI chat tool_calls, Anthropic tool_use, Responses function_call), with
 * the index of the first request that carried it.
 */
function toolCallsOf(requests) {
  const seen = new Map();
  const visit = (node, index) => {
    if (Array.isArray(node)) return node.forEach((n) => visit(n, index));
    if (!node || typeof node !== "object") return;
    let call;
    if (node.type === "function" && node.function?.name && node.id) {
      call = {
        id: node.id,
        name: node.function.name,
        args: node.function.arguments,
      };
    } else if (node.type === "tool_use" && node.name && node.id) {
      call = { id: node.id, name: node.name, args: node.input };
    } else if (node.type === "function_call" && node.name && node.call_id) {
      call = { id: node.call_id, name: node.name, args: node.arguments };
    }
    if (call && !seen.has(call.id)) {
      let args = call.args;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      seen.set(call.id, { index, name: call.name, args: args ?? {} });
    }
    for (const value of Object.values(node)) visit(value, index);
  };
  requests.forEach((request, index) => visit(request.body, index));
  return [...seen.values()];
}

/**
 * Reads of a path that an earlier Read had already returned, once a
 * compaction had happened in between. Needs the request files that
 * NEXTCLI_TRACE=full writes: a basic trace has tool names but no arguments,
 * so this returns null for it.
 */
export function analyzeToolCalls(traceDir, workDir, compactions) {
  const requests = readRequestFiles(traceDir);
  if (requests.length === 0) return null;
  const calls = toolCallsOf(requests);
  const rel = (p) =>
    typeof p === "string"
      ? path.relative(workDir, path.resolve(workDir, p))
      : "";
  // The summary request of each compaction is the request sent in its window
  const boundaries = compactions
    .map((c) =>
      requests.findIndex(
        (r) => r.ts >= c.ts && r.ts <= c.ts + (c.dur ?? 0) + 50,
      ),
    )
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  const reads = calls.filter((c) => c.name === "Read");
  let rereads = 0;
  for (const read of reads) {
    const boundary = boundaries.findLast((b) => b < read.index);
    if (boundary === undefined) continue;
    const path1 = rel(read.args.filepath);
    if (
      reads.some((r) => r.index <= boundary && rel(r.args.filepath) === path1)
    ) {
      rereads += 1;
    }
  }
  const counts = new Map();
  for (const call of calls) {
    if (call.name === "Checklist") continue;
    const key = call.name + JSON.stringify(call.args);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    toolCalls: calls.length,
    reads: reads.length,
    rereads,
    repeatedMax: Math.max(0, ...counts.values()),
  };
}

export function summarizeTrace(traceDir, workDir) {
  const lines = readTrace(traceDir);
  const llm = lines.filter((l) => l.name === "llm.request");
  const compactions = lines.filter((l) => l.name === "context.compaction");
  const sum = (items, pick) => items.reduce((total, i) => total + pick(i), 0);
  const inWindow = (call, c) =>
    call.ts >= c.ts && call.ts <= c.ts + (c.dur ?? 0);
  const summaryCalls = llm.filter((l) =>
    compactions.some((c) => inWindow(l, c)),
  );
  const outcomes = (name) =>
    compactions.filter((c) => c.attrs.outcome === name);
  const tools = {};
  for (const call of llm) {
    for (const name of call.attrs.toolCalls ?? [])
      tools[name] = (tools[name] ?? 0) + 1;
  }
  return {
    requests: llm.length,
    failedRequests: llm.filter((l) => l.attrs.error).length,
    inputTokens: sum(llm, (l) => usageOf(l.attrs).input),
    cachedTokens: sum(llm, (l) => usageOf(l.attrs).cached),
    outputTokens: sum(llm, (l) => usageOf(l.attrs).output),
    peakInputTokens: Math.max(0, ...llm.map((l) => usageOf(l.attrs).input)),
    costUsd: sum(llm, (l) => l.attrs.costUsd ?? 0),
    compactions: outcomes("compacted").length,
    compactionsFailed: outcomes("failed").length,
    compactionsCancelled: outcomes("cancelled").length,
    compactionRequests: summaryCalls.length,
    compactionCostUsd: sum(summaryCalls, (l) => l.attrs.costUsd ?? 0),
    omittedMessages: sum(
      outcomes("compacted"),
      (c) => c.attrs.omittedMessages ?? 0,
    ),
    shortenedOutputs: sum(
      outcomes("compacted"),
      (c) => c.attrs.shortenedOutputs ?? 0,
    ),
    tools,
    calls: analyzeToolCalls(
      traceDir,
      workDir,
      compactions.map((c) => ({ ts: c.ts, dur: c.dur })),
    ),
  };
}

/** The headless run summary: the last JSON line cn wrote to stderr */
export function parseSummaryLine(stderr) {
  for (const line of stderr.trim().split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.status) return parsed;
    } catch {
      // not the summary line
    }
  }
  return null;
}

/** The answer text of a `--format json` run */
export function answerOf(stdout) {
  const text = stdout.trim();
  try {
    const parsed = JSON.parse(text);
    return String(parsed.response ?? text);
  } catch {
    return text;
  }
}

const normalize = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[`'"*_\s]+/g, " ")
    .trim();

const names = (text) =>
  new Set(
    (String(text).match(/[\w@./-]+\.[A-Za-z0-9]+/g) ?? []).map((p) =>
      path.basename(p.replace(/^\.\//, "")),
    ),
  );

/** Grades one reply: { ok, score }. Sets score by overlap, the rest 0 or 1. */
export function gradeProbe(probe, reply, editedFiles) {
  if (probe.grader === "edited") {
    const want = new Set(editedFiles.map((f) => path.basename(f)));
    const got = names(reply);
    const both = [...want].filter((f) => got.has(f)).length;
    const union = new Set([...want, ...got]).size;
    const score = union === 0 ? 1 : both / union;
    return { ok: score === 1, score };
  }
  const answer = normalize(reply);
  const ok = normalize(probe.expected)
    .split(" ")
    .every((part) => answer.includes(part));
  return { ok, score: ok ? 1 : 0 };
}
