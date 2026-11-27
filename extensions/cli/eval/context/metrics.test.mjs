import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gradeProbe, summarizeTrace } from "./metrics.mjs";

const value = (expected) => ({ grader: "contains", expected });

describe("gradeProbe", () => {
  it("needs the expected value as a whole word", () => {
    // Task 3's delay is two digits; task 7's code four or five
    expect(gradeProbe(value("42"), "The delay is 42.", []).ok).toBe(true);
    for (const reply of ["142", "420 seconds", "delay=342"]) {
      expect(gradeProbe(value("42"), reply, []).ok).toBe(false);
    }
    expect(gradeProbe(value("1000"), "CODE: 10000", []).ok).toBe(false);
    expect(gradeProbe(value("1000"), "`1000`", []).ok).toBe(true);
  });

  it("needs every part of a two-part answer", () => {
    const probe = value("E-4821 registry.ts");
    expect(gradeProbe(probe, "E-4821 src/registry.ts", []).ok).toBe(true);
    expect(gradeProbe(probe, "E-4821 registry.json", []).ok).toBe(false);
    expect(gradeProbe(probe, "E-48210 registry.ts", []).ok).toBe(false);
  });

  it("takes a file name given with its path", () => {
    const probe = value("vendor_cedar.ts");
    expect(gradeProbe(probe, "src/frozen/vendor_cedar.ts", []).ok).toBe(true);
  });

  it("scores the files edited by overlap with what the run changed", () => {
    const probe = { grader: "edited" };
    const edited = ["src/a.ts", "NOTES.md"];
    expect(gradeProbe(probe, "src/a.ts, NOTES.md", edited)).toEqual({
      ok: true,
      score: 1,
    });
    expect(gradeProbe(probe, "src/a.ts, src/b.ts", edited)).toEqual({
      ok: false,
      score: 1 / 3,
    });
  });

  it("can't grade the files edited of a run that changed nothing", () => {
    expect(
      gradeProbe({ grader: "edited" }, "I edited nothing.", []),
    ).toMatchObject({ ok: false, na: true });
  });
});

describe("summarizeTrace", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-trace-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const line = (name, attrs, ts = 1) => JSON.stringify({ ts, name, attrs });
  const request = (session, n, ids) => {
    const folder = path.join(dir, `${session}-run1`);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, `request-${n}.json`),
      JSON.stringify({
        ts: n,
        body: {
          messages: ids.map((id) => ({
            role: "assistant",
            tool_calls: [
              {
                id,
                type: "function",
                function: { name: "Read", arguments: '{"filepath":"a.ts"}' },
              },
            ],
          })),
        },
      }),
    );
  };

  it("counts only the run's own session", () => {
    fs.writeFileSync(
      path.join(dir, "eval-t1-run1.jsonl"),
      line("llm.request", { usage: { prompt_tokens: 100 } }) + "\n",
    );
    fs.writeFileSync(
      path.join(dir, "other-run1.jsonl"),
      [
        line("llm.request", { usage: { prompt_tokens: 900 } }),
        line("context.compaction", { outcome: "compacted" }),
      ].join("\n") + "\n",
    );
    request("eval-t1", 1, ["call_1"]);
    request("eval-t1", 2, ["call_1", "call_2"]);
    request("other", 1, ["call_9", "call_8", "call_7"]);

    const summary = summarizeTrace(dir, "eval-t1", dir);

    expect(summary.inputTokens).toBe(100);
    expect(summary.compactions).toBe(0);
    expect(summary.calls).toMatchObject({ toolCalls: 2, reads: 2 });
  });

  it("counts requests larger than the window under test", () => {
    fs.writeFileSync(
      path.join(dir, "eval-t1-run1.jsonl"),
      [
        line("llm.request", { usage: { prompt_tokens: 60_000 } }),
        line("llm.request", { usage: { prompt_tokens: 74_135 } }),
      ].join("\n") + "\n",
    );

    expect(summarizeTrace(dir, "eval-t1", dir, 64_000).overWindow).toBe(1);
  });

  it("counts cache writes, prefix breaks and dropped summary tool calls", () => {
    fs.writeFileSync(
      path.join(dir, "eval-t1-run1.jsonl"),
      [
        line(
          "llm.request",
          {
            usage: {
              prompt_tokens: 100,
              prompt_tokens_details: { cache_write_tokens: 90 },
            },
            prefix: { systemHash: "s", toolsHash: "t" },
          },
          1,
        ),
        line(
          "llm.request",
          {
            usage: { prompt_tokens: 120, prompt_cache_hit_tokens: 90 },
            toolCalls: ["List"],
            prefix: { systemHash: "s", toolsHash: "t", extendsPrevious: true },
          },
          2,
        ),
        // The compaction's summary call, which asked for a tool anyway
        line(
          "llm.request",
          {
            usage: { prompt_tokens: 130 },
            toolCalls: ["Read"],
            prefix: { extendsPrevious: true },
          },
          10,
        ),
        JSON.stringify({
          ts: 9,
          dur: 5,
          name: "context.compaction",
          attrs: { outcome: "compacted" },
        }),
        line(
          "llm.request",
          {
            usage: { prompt_tokens: 40 },
            prefix: { extendsPrevious: false, changed: ["messages"] },
          },
          20,
        ),
        line(
          "llm.request",
          {
            usage: { prompt_tokens: 60 },
            prefix: { extendsPrevious: false, changed: ["reasoning"] },
          },
          30,
        ),
        // A wrap-up: a break, though its reasoning text changed too
        line(
          "llm.request",
          {
            usage: { prompt_tokens: 70 },
            prefix: {
              extendsPrevious: false,
              changed: ["settings", "tools", "reasoning"],
            },
          },
          40,
        ),
      ].join("\n") + "\n",
    );

    expect(summarizeTrace(dir, "eval-t1", dir)).toMatchObject({
      cachedTokens: 90,
      cacheWriteTokens: 90,
      prefixBreaks: 2,
      reasoningDrops: 1,
      compactionRequests: 1,
      summaryToolCalls: 1,
    });
  });

  it("skips a request file cut short by a killed run", () => {
    request("eval-t1", 1, ["call_1"]);
    fs.writeFileSync(
      path.join(dir, "eval-t1-run1", "request-2.json"),
      '{"ts": 2, "body": {"mess',
    );

    expect(summarizeTrace(dir, "eval-t1", dir).calls).toMatchObject({
      toolCalls: 1,
    });
  });

  it("has no tool-call counts without request files", () => {
    fs.writeFileSync(
      path.join(dir, "eval-t1-run1.jsonl"),
      line("llm.request", { toolCalls: ["Read"] }) + "\n",
    );

    expect(summarizeTrace(dir, "eval-t1", dir).calls).toBeNull();
  });
});
