import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { abortAll, resetAbortRegistryForTests } from "../util/abortRegistry.js";

import { handleToolCalls } from "./handleToolCalls.js";
import { streamChatResponse } from "./streamChatResponse.js";

const sessionUsage = { promptTokens: 0, completionTokens: 0, totalCost: 0 };

vi.mock("../compaction.js", () => ({
  compactChatHistory: vi.fn(),
  pruneLastMessage: vi.fn((history) => history.slice(0, -1)),
  shouldAutoCompact: vi.fn(),
  getAutoCompactMessage: vi.fn(() => "Auto-compacting..."),
}));

vi.mock("../session.js", () => ({
  updateSessionHistory: vi.fn(),
  trackSessionUsage: vi.fn(),
  getSessionUsage: vi.fn(() => ({ ...sessionUsage })),
}));

vi.mock("../util/tokenizer.js", () => ({
  countChatHistoryItemTokens: vi.fn(() => 100),
  validateContextLength: vi.fn(() => ({ isValid: true })),
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

vi.mock("../services/index.js", () => ({
  services: {
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
