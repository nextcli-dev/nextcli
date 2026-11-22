import type { ModelConfig } from "@nextcli/config-yaml";
import type { ChatHistoryItem } from "core/index.js";
import { render } from "ink-testing-library";
import React, { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { useContextPercentage } from "./useContextPercentage.js";

const prefix = vi.hoisted(() => vi.fn());
const countHistory = vi.hoisted(() => vi.fn());

vi.mock("../../context/snapshot.js", () => ({
  nextRequestPrefix: prefix,
  prefixTokens: () => 150,
}));

vi.mock("../../util/tokenizer.js", () => ({
  countChatHistoryTokens: countHistory,
}));

vi.mock("../../compaction.js", () => ({
  autoCompactThreshold: () => ({
    contextLimit: 200_000,
    maxTokens: 64_000,
    compactionBuffer: 15_000,
    compactionThreshold: 121_000,
  }),
}));

const model = {
  name: "Test",
  model: "test",
  provider: "openai",
} as ModelConfig;

function Probe(props: {
  history: ChatHistoryItem[];
  streaming: boolean;
  onUsage: (used: number | null) => void;
}) {
  const usage = useContextPercentage({
    chatHistory: props.history,
    model,
    mode: "normal",
    isRemoteMode: false,
    isStreaming: props.streaming,
  });
  useEffect(() => {
    props.onUsage(usage?.used ?? null);
  }, [usage, props]);
  return null;
}

const history = (text: string): ChatHistoryItem[] => [
  { message: { role: "user", content: text }, contextItems: [] },
];

describe("useContextPercentage", () => {
  it("includes the system prompt and tools, and does not recount while streaming", async () => {
    prefix.mockResolvedValue({ systemMessage: "sys", tools: [] });
    countHistory.mockReturnValue(50);
    const seen: Array<number | null> = [];
    const { rerender } = render(
      <Probe
        history={history("hello")}
        streaming={false}
        onUsage={(used) => seen.push(used)}
      />,
    );

    await vi.waitFor(() => {
      expect(seen).toContain(200);
    });
    const beforeStream = countHistory.mock.calls.length;

    rerender(
      <Probe
        history={history("hello".repeat(40))}
        streaming={true}
        onUsage={(used) => seen.push(used)}
      />,
    );
    await vi.waitFor(() => {
      expect(countHistory.mock.calls.length).toBeGreaterThan(beforeStream);
    });
    const duringStream = countHistory.mock.calls.length;

    rerender(
      <Probe
        history={history("hello".repeat(80))}
        streaming={true}
        onUsage={(used) => seen.push(used)}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(countHistory.mock.calls.length).toBe(duringStream);
  });
});
