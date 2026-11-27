import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { abortAll, resetAbortRegistryForTests } from "../util/abortRegistry.js";

import { handleToolCalls } from "./handleToolCalls.js";
import { handlePreApiCompaction } from "./streamChatResponse.compactionHelpers.js";
import { streamChatResponse } from "./streamChatResponse.js";

const sessionUsage = { promptTokens: 0, completionTokens: 0, totalCost: 0 };

vi.mock("../compaction.js", () => ({
  compactChatHistory: vi.fn(),
  shouldAutoCompact: vi.fn(),
  getAutoCompactMessage: vi.fn(() => "Auto-compacting..."),
}));

vi.mock("../session.js", () => ({
  updateSessionHistory: vi.fn(),
  trackSessionUsage: vi.fn(),
  getSessionUsage: vi.fn(() => ({ ...sessionUsage })),
}));

vi.mock("../util/tokenizer.js", () => ({
  historySentToModel: (history: { message: { role: string } }[]) =>
    history.filter((item) => item.message.role !== "system"),
  countChatHistoryItemTokens: vi.fn(() => 100),
  validateContextLength: vi.fn(() => ({ isValid: true })),
  estimateOutputTokens: vi.fn(() => 0),
}));

vi.mock("../telemetry/telemetryService.js", () => ({
  telemetryService: {
    logApiRequest: vi.fn(),
    recordResponseTime: vi.fn(),
    recordTokenUsage: vi.fn(),
    recordCost: vi.fn(),
  },
}));

vi.mock("../util/logger.js", () => ({
  logger: {
    trace: vi.fn(),
    verbose: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

const mcpState = vi.hoisted(() => ({ tools: [] as unknown[] }));

vi.mock("../services/index.js", () => ({
  services: {
    // One array: the request prefix rebuilds when the MCP tools change
    mcp: { getState: vi.fn(() => mcpState) },
    systemMessage: {
      getSystemMessage: vi.fn(() => Promise.resolve("System message")),
    },
    toolPermissions: {
      getState: vi.fn(() => ({ currentMode: "enabled" })),
      isHeadless: vi.fn(() => true),
    },
    chatHistory: {
      isReady: vi.fn(() => true),
      getHistory: vi.fn(() => []),
      setHistory: vi.fn(),
      addUserMessage: vi.fn(),
    },
  },
}));

vi.mock("./handleToolCalls.js", () => ({
  handleToolCalls: vi.fn(() => Promise.resolve(false)),
  getRequestTools: vi.fn(() => Promise.resolve([])),
}));

vi.mock("./streamChatResponse.compactionHelpers.js", () => ({
  handlePreApiCompaction: vi.fn((chatHistory) =>
    Promise.resolve({ chatHistory, wasCompacted: false }),
  ),
  handlePostToolValidation: vi.fn((_, chatHistory) =>
    Promise.resolve({ chatHistory, wasCompacted: false }),
  ),
  handleNormalAutoCompaction: vi.fn((chatHistory) =>
    Promise.resolve({ chatHistory, wasCompacted: false }),
  ),
}));

function chunk(delta: ChatCompletionChunk["choices"][0]["delta"]) {
  return {
    id: "test",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: null }],
  } as ChatCompletionChunk;
}

const touchMarker = chunk({
  tool_calls: [
    {
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "Bash", arguments: '{"command":"touch /tmp/marker"}' },
    },
  ],
});

// #12701: SIGINT runs gracefulExit, which calls abortAll(). A tool call the
// provider delivers after that must never be dispatched.
describe("streamChatResponse - interrupt", () => {
  const model = {
    provider: "openai",
    name: "gpt-4",
    model: "gpt-4",
    defaultCompletionOptions: { contextLength: 8192, maxTokens: 2048 },
  } as unknown as ModelConfig;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetAbortRegistryForTests();
  });

  it("does not dispatch a tool call that arrives after the interrupt", async () => {
    const llmApi = {
      chatCompletionStream: vi.fn().mockImplementation(async function* () {
        yield chunk({ content: "Working on it" });
        abortAll();
        yield touchMarker;
      }),
    } as unknown as BaseLlmApi;
    const abortController = new AbortController();

    await streamChatResponse([], model, llmApi, abortController);

    expect(abortController.signal.aborted).toBe(true);
    expect(handleToolCalls).not.toHaveBeenCalled();
  });

  it("does not start a turn once shutdown has begun", async () => {
    const llmApi = {
      chatCompletionStream: vi.fn().mockImplementation(async function* () {
        yield touchMarker;
      }),
    } as unknown as BaseLlmApi;
    abortAll();

    await streamChatResponse([], model, llmApi, new AbortController());

    expect(handleToolCalls).not.toHaveBeenCalled();
  });

  it("ends the turn without a model call when Escape stops a compaction", async () => {
    const llmApi = {
      chatCompletionStream: vi.fn().mockImplementation(async function* () {
        yield chunk({ content: "should not be asked" });
      }),
    } as unknown as BaseLlmApi;
    const abortController = new AbortController();
    vi.mocked(handlePreApiCompaction).mockImplementationOnce(
      async (chatHistory, options) => {
        // Escape while the summary streams
        options.abortController?.abort();
        return { chatHistory, wasCompacted: false };
      },
    );

    await streamChatResponse([], model, llmApi, abortController);

    expect(
      vi.mocked(handlePreApiCompaction).mock.calls[0][1].abortController,
    ).toBe(abortController);
    expect(llmApi.chatCompletionStream).not.toHaveBeenCalled();
  });

  it("still aborts the turn on exit after a compaction ran inside it", async () => {
    let calls = 0;
    const llmApi = {
      chatCompletionStream: vi.fn().mockImplementation(async function* () {
        calls++;
        if (calls === 1) {
          // The summary request
          yield chunk({ content: "Summary" });
          return;
        }
        yield chunk({ content: "Working on it" });
        abortAll();
        yield touchMarker;
      }),
    } as unknown as BaseLlmApi;
    const abortController = new AbortController();
    // The summary runs as a nested stream with the turn's controller
    vi.mocked(handlePreApiCompaction).mockImplementationOnce(
      async (chatHistory, options) => {
        await streamChatResponse(
          chatHistory,
          model,
          llmApi,
          options.abortController!,
          undefined,
          true,
        );
        return { chatHistory, wasCompacted: false };
      },
    );

    await streamChatResponse([], model, llmApi, abortController);

    expect(calls).toBe(2);
    expect(abortController.signal.aborted).toBe(true);
    // The tool call that arrived after the exit never ran
    const dispatched = vi
      .mocked(handleToolCalls)
      .mock.calls.flatMap(([options]) => options.toolCalls);
    expect(dispatched).toEqual([]);
  });

  it("passes the turn's signal to tool dispatch", async () => {
    const llmApi = {
      chatCompletionStream: vi.fn().mockImplementation(async function* () {
        yield touchMarker;
      }),
    } as unknown as BaseLlmApi;
    const abortController = new AbortController();
    vi.mocked(handleToolCalls).mockResolvedValueOnce(true);

    await streamChatResponse([], model, llmApi, abortController);

    expect(handleToolCalls).toHaveBeenCalledWith(
      expect.objectContaining({ signal: abortController.signal }),
    );
  });
});
