import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { compactChatHistory } from "./compaction.js";
import { handleAutoCompaction } from "./stream/streamChatResponse.autoCompaction.js";

const trace = vi.hoisted(() => ({
  on: true,
  events: [] as { name: string; attrs: Record<string, unknown> }[],
}));

vi.mock("./trace/trace.js", () => ({
  traceEnabled: () => trace.on,
  traceEvent: (name: string, attrs: Record<string, unknown>) => {
    if (name === "context.compaction") {
      trace.events.push({ name, attrs });
    }
  },
}));

const mcpState = vi.hoisted(() => ({ tools: [] as unknown[] }));

vi.mock("./services/index.js", () => ({
  services: {
    // One array: the request prefix rebuilds when the MCP tools change
    mcp: { getState: vi.fn(() => mcpState) },
    systemMessage: {
      getSystemMessage: vi.fn(() => Promise.resolve("System prompt")),
    },
    toolPermissions: {
      getState: vi.fn(() => ({ currentMode: "enabled" })),
      isHeadless: vi.fn(() => true),
    },
    chatHistory: { isReady: vi.fn(() => true), getHistory: vi.fn(() => []) },
  },
}));

vi.mock("./stream/handleToolCalls.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stream/handleToolCalls.js")>()),
  getRequestTools: vi.fn(async () => []),
}));

vi.mock("./session.js", () => ({
  updateSessionHistory: vi.fn(),
  trackSessionUsage: vi.fn(),
  getSessionUsage: vi.fn(() => ({
    promptTokens: 0,
    completionTokens: 0,
    totalCost: 0,
  })),
}));

vi.mock("./util/logger.js", () => ({
  logger: {
    trace: vi.fn(),
    verbose: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const user = (content: string): ChatHistoryItem => ({
  message: { role: "user", content },
  contextItems: [],
});
const assistant = (content: string): ChatHistoryItem => ({
  message: { role: "assistant", content },
  contextItems: [],
});

describe("the context.compaction trace event", () => {
  const model = {
    name: "small",
    provider: "openai",
    model: "gpt-4o",
    defaultCompletionOptions: { contextLength: 10_000, maxTokens: 1_000 },
  } as ModelConfig;
  let summary: string;
  let llmApi: BaseLlmApi;
  const history = [
    user(" hello".repeat(1_500)),
    assistant(" world".repeat(1_500)),
    user("the task"),
  ];

  beforeEach(() => {
    trace.on = true;
    trace.events = [];
    summary = "Summary of the work";
    llmApi = {
      chatCompletionStream: vi.fn().mockImplementation(async function* () {
        yield {
          id: "1",
          object: "chat.completion.chunk",
          created: 0,
          model: "gpt-4o",
          choices: [
            { index: 0, delta: { content: summary }, finish_reason: null },
          ],
        };
      }),
    } as unknown as BaseLlmApi;
  });

  it("writes one event for a manual compaction, with counts only", async () => {
    await compactChatHistory(history, model, llmApi);

    expect(trace.events).toHaveLength(1);
    const { attrs } = trace.events[0];
    expect(attrs).toEqual({
      trigger: "manual",
      outcome: "compacted",
      tokensBefore: expect.any(Number),
      tokensAfter: expect.any(Number),
      omittedMessages: 0,
      shortenedOutputs: 0,
    });
    expect(attrs.tokensBefore as number).toBeGreaterThan(
      attrs.tokensAfter as number,
    );
    expect(JSON.stringify(attrs)).not.toContain(summary);
  });

  it("records a failure that never reached the model", async () => {
    // What follows the summary leaves it no room in the window
    await expect(
      compactChatHistory(history, model, llmApi, {
        followedBy: [user(" next".repeat(20_000))],
      }),
    ).rejects.toThrow();

    expect(llmApi.chatCompletionStream).not.toHaveBeenCalled();
    expect(trace.events).toHaveLength(1);
    expect(trace.events[0].attrs).toEqual({
      trigger: "manual",
      outcome: "failed",
      tokensBefore: expect.any(Number),
    });
  });

  it("marks an auto compaction and counts what the summary request cut", async () => {
    const big = [
      user(" hello".repeat(9_000)),
      assistant("ok"),
      user("the task"),
      assistant("the last step"),
    ];

    const result = await handleAutoCompaction(big, model, llmApi, {
      isHeadless: true,
    });

    expect(result.wasCompacted).toBe(true);
    expect(trace.events).toHaveLength(1);
    expect(trace.events[0].attrs).toMatchObject({
      trigger: "auto",
      outcome: "compacted",
      omittedMessages: 2,
    });
  });

  it("writes a failed event, without after counts, when the summary is empty", async () => {
    summary = "";

    await expect(compactChatHistory(history, model, llmApi)).rejects.toThrow(
      "empty summary",
    );

    expect(trace.events).toHaveLength(1);
    expect(trace.events[0].attrs).toEqual({
      trigger: "manual",
      outcome: "failed",
      tokensBefore: expect.any(Number),
    });
  });

  it("writes a cancelled event when the user aborts", async () => {
    const abortController = new AbortController();
    vi.mocked(llmApi.chatCompletionStream).mockImplementation(
      async function* () {
        abortController.abort();
        yield {
          id: "1",
          object: "chat.completion.chunk",
          created: 0,
          model: "gpt-4o",
          choices: [
            { index: 0, delta: { content: "part" }, finish_reason: null },
          ],
        };
      },
    );

    await expect(
      compactChatHistory(history, model, llmApi, { abortController }),
    ).rejects.toThrow("cancelled");

    expect(trace.events.map((e) => e.attrs.outcome)).toEqual(["cancelled"]);
  });

  it("writes nothing and counts nothing when tracing is off", async () => {
    trace.on = false;

    await compactChatHistory(history, model, llmApi);

    expect(trace.events).toEqual([]);
  });
});
