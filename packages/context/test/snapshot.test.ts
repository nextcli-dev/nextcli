import { describe, expect, it } from "vitest";

import { buildSnapshot, type ContextSegment } from "../src/index.js";

const segment = (id: string, tokens: number): ContextSegment => ({
  id,
  label: id,
  tokens,
  source: "estimated",
});

describe("buildSnapshot", () => {
  it("sums used from the top-level segments and returns the five largest tool results", () => {
    const snapshot = buildSnapshot({
      window: 200_000,
      threshold: {
        tokens: 121_000,
        action: "auto-compaction",
        steps: [
          { label: "model context length", tokens: 200_000 },
          { label: "output reserve", tokens: -64_000 },
          { label: "buffer", tokens: -15_000 },
        ],
      },
      segments: [
        segment("system", 1_000),
        segment("tools", 2_000),
        segment("history", 3_000),
      ],
      toolResults: [
        { label: "read", tokens: 10 },
        { label: "grep", tokens: 80 },
        { label: "bash", tokens: 40 },
        { label: "edit", tokens: 20 },
        { label: "fetch", tokens: 60 },
        { label: "write", tokens: 50 },
      ],
      pruned: { messages: 2, tokens: 400 },
    });

    expect(snapshot.used).toBe(6_000);
    expect(snapshot.largestToolResults).toEqual([
      { label: "grep", tokens: 80 },
      { label: "fetch", tokens: 60 },
      { label: "write", tokens: 50 },
      { label: "bash", tokens: 40 },
      { label: "edit", tokens: 20 },
    ]);
    expect(snapshot.pruned).toEqual({ messages: 2, tokens: 400 });
  });
});
