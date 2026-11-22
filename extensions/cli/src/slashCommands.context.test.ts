import type { ContextSnapshot } from "@nextcli/context";
import { describe, expect, it } from "vitest";

import { renderContextReport } from "./context/report.js";

const snapshot: ContextSnapshot = {
  window: 200_000,
  used: 46_000,
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
    {
      id: "system",
      label: "System",
      tokens: 1_000,
      source: "estimated",
      children: [
        {
          id: "rule-0",
          label: "AGENTS.md",
          tokens: 400,
          source: "estimated",
        },
      ],
    },
    {
      id: "tools",
      label: "Tools",
      tokens: 2_000,
      source: "estimated",
      children: [
        {
          id: "mcp-docs",
          label: "docs",
          tokens: 2_000,
          source: "estimated",
        },
      ],
    },
  ],
  largestToolResults: [{ label: "read_file", tokens: 800 }],
};

describe("/context", () => {
  it("names the rule file, the MCP group and the threshold line", () => {
    const output = renderContextReport(snapshot, {
      promptTokens: 12_000,
      completionTokens: 800,
      promptTokensDetails: { cachedTokens: 9_000, cacheWriteTokens: 100 },
    });
    expect(output).toContain("AGENTS.md");
    expect(output).toContain("docs");
    expect(output).toContain("64,000 output reserve");
    expect(output).toContain("15,000 buffer");
    expect(output).toContain("= 121,000");
    expect(output).toContain("cache hit 75%");
    // The tree is exact. The window-scale header stays in K.
    expect(output).toContain("Context 46K of 200K");
    expect(output).toContain("AGENTS.md  400  estimated");
    expect(output).toContain("read_file  800  estimated");
    expect(output).toContain("System  1,000  estimated");
  });

  it("does not call a missing or partial usage measured", () => {
    expect(renderContextReport(snapshot, undefined)).toContain(
      "Measured: no provider usage for the last response",
    );
    expect(
      renderContextReport(snapshot, {
        promptTokens: undefined,
        completionTokens: undefined,
      } as unknown as Parameters<typeof renderContextReport>[1]),
    ).toContain("Measured: no provider usage for the last response");
  });
});
