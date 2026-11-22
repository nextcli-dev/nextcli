import type { ModelConfig } from "@nextcli/config-yaml";
import type { ChatHistoryItem } from "core/index.js";
import { render } from "ink-testing-library";
import React, { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useContextPercentage } from "./useContextPercentage.js";

const prefix = vi.hoisted(() => vi.fn());
const countHistory = vi.hoisted(() => vi.fn());
const mcp = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    connections: [] as {
      status: string;
      config: { name: string };
      tools: { name: string }[];
    }[],
  };
  return {
    listeners,
    state,
    emit() {
      for (const listener of listeners) listener();
    },
  };
});

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

vi.mock("../../services/index.js", () => ({
  services: {
    mcp: {
      getState: () => mcp.state,
      on: (_event: string, listener: () => void) => {
        mcp.listeners.add(listener);
      },
      off: (_event: string, listener: () => void) => {
        mcp.listeners.delete(listener);
      },
    },
  },
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

const item = (
  role: "user" | "assistant" | "tool",
  content: string,
  extra: Record<string, unknown> = {},
): ChatHistoryItem =>
  ({
    message: { role, content, ...extra },
    contextItems: [],
  }) as ChatHistoryItem;

describe("useContextPercentage", () => {
  beforeEach(() => {
    prefix.mockReset();
    countHistory.mockReset();
    mcp.state.connections = [];
    prefix.mockResolvedValue({ systemMessage: "sys", tools: [] });
    countHistory.mockImplementation(
      (history: ChatHistoryItem[]) => history.length * 10,
    );
  });

  it("keeps the last value for answer chunks and recounts tool results and compaction", async () => {
    const seen: Array<number | null> = [];
    const history = [item("user", "hello"), item("assistant", "a")];
    const { rerender } = render(
      <Probe
        history={history}
        streaming={false}
        onUsage={(used) => seen.push(used)}
      />,
    );

    await vi.waitFor(() => {
      expect(seen).toContain(170);
    });
    const beforeStream = countHistory.mock.calls.length;

    rerender(
      <Probe
        history={[item("user", "hello"), item("assistant", "a".repeat(40))]}
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
        history={[item("user", "hello"), item("assistant", "a".repeat(80))]}
        streaming={true}
        onUsage={(used) => seen.push(used)}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(countHistory.mock.calls.length).toBe(duringStream);

    rerender(
      <Probe
        history={[
          item("user", "hello"),
          item("assistant", "a".repeat(80)),
          item("tool", "file contents ".repeat(50), { toolCallId: "call-1" }),
        ]}
        streaming={true}
        onUsage={(used) => seen.push(used)}
      />,
    );
    await vi.waitFor(() => {
      expect(seen).toContain(180);
    });

    rerender(
      <Probe
        history={[
          {
            ...item("assistant", "summary"),
            conversationSummary: "The work so far",
          },
        ]}
        streaming={true}
        onUsage={(used) => seen.push(used)}
      />,
    );
    await vi.waitFor(() => {
      expect(seen).toContain(160);
    });
  });

  it("applies the count that started the turn when the first chunk arrives first", async () => {
    const pending: Array<
      (value: { systemMessage: string; tools: never[] }) => void
    > = [];
    prefix.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    const seen: Array<number | null> = [];
    const { rerender } = render(
      <Probe
        history={[item("user", "hello")]}
        streaming={false}
        onUsage={(used) => seen.push(used)}
      />,
    );
    await vi.waitFor(() => expect(pending.length).toBe(1));

    rerender(
      <Probe
        history={[item("user", "hello"), item("assistant", "a")]}
        streaming={true}
        onUsage={(used) => seen.push(used)}
      />,
    );
    await vi.waitFor(() => expect(pending.length).toBe(2));

    rerender(
      <Probe
        history={[item("user", "hello"), item("assistant", "a".repeat(40))]}
        streaming={true}
        onUsage={(used) => seen.push(used)}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pending.length).toBe(2);

    pending[1]?.({ systemMessage: "sys", tools: [] });
    await vi.waitFor(() => expect(seen).toContain(170));
  });

  it("does not reject when the prefix fails, and a later change still counts", async () => {
    prefix.mockRejectedValueOnce(new Error("tools failed"));
    const seen: Array<number | null> = [];
    const { rerender } = render(
      <Probe
        history={[item("user", "a")]}
        streaming={false}
        onUsage={(used) => seen.push(used)}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen.filter((used) => used !== null)).toEqual([]);

    rerender(
      <Probe
        history={[item("user", "ab")]}
        streaming={false}
        onUsage={(used) => seen.push(used)}
      />,
    );
    await vi.waitFor(() => expect(seen).toContain(160));
  });

  it("recounts when an MCP server connects", async () => {
    const seen: Array<number | null> = [];
    render(
      <Probe
        history={[item("user", "hello")]}
        streaming={false}
        onUsage={(used) => seen.push(used)}
      />,
    );
    await vi.waitFor(() => expect(seen).toContain(160));
    const calls = prefix.mock.calls.length;

    mcp.state.connections = [
      {
        status: "connected",
        config: { name: "docs" },
        tools: [{ name: "search" }],
      },
    ];
    mcp.emit();

    await vi.waitFor(() =>
      expect(prefix.mock.calls.length).toBeGreaterThan(calls),
    );
  });
});
