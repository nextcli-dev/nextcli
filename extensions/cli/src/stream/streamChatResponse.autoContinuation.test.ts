import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import { convertToUnifiedHistory } from "core/util/messageConversion.js";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureAgentLoopLimits,
  resetAgentLoopLimits,
} from "./agentLoopLimits.js";
import { streamChatResponse } from "./streamChatResponse.js";
import { EMPTY_ANSWER_PROMPT, requireFinalAnswer } from "./turnContinuation.js";

// Mock all dependencies
vi.mock("../compaction.js", () => ({
  compactChatHistory: vi.fn(),
  pruneLastMessage: vi.fn((history) => history.slice(0, -1)),
  shouldAutoCompact: vi.fn(),
  getAutoCompactMessage: vi.fn(() => "Auto-compacting..."),
}));

vi.mock("../session.js", () => ({
  updateSessionHistory: vi.fn(),
  trackSessionUsage: vi.fn(),
}));

vi.mock("../util/tokenizer.js", () => ({
  countChatHistoryItemTokens: vi.fn(() => 100),
  countTotalInputTokens: vi.fn(() => 100),
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
      isHeadless: vi.fn(() => false),
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

describe("streamChatResponse - compaction checks", () => {
  const mockModel: ModelConfig = {
    provider: "openai",
    name: "gpt-4",
    model: "gpt-4",
    defaultCompletionOptions: {
      contextLength: 8192,
      maxTokens: 2048,
    },
  } as any;

  const prompt = "Review this pull request. Answer in JSON.";

  function contentChunk(content: string): ChatCompletionChunk {
    return {
      id: "test",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "test-model",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    };
  }

  function answering(): BaseLlmApi {
    return {
      chatCompletionStream: vi.fn().mockImplementation(async function* () {
        yield contentChunk("done");
      }),
    } as unknown as BaseLlmApi;
  }

  async function run(llmApi: BaseLlmApi) {
    await streamChatResponse(
      convertToUnifiedHistory([{ role: "user", content: prompt }]),
      mockModel,
      llmApi,
      { signal: { aborted: false }, abort: vi.fn() } as any,
    );
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const { services } = await import("../services/index.js");
    vi.mocked(services.toolPermissions.isHeadless).mockReturnValue(false);
    const { handleToolCalls } = await import("./handleToolCalls.js");
    vi.mocked(handleToolCalls).mockResolvedValue(false);
  });

  afterEach(async () => {
    const { handlePreApiCompaction } = await import(
      "./streamChatResponse.compactionHelpers.js"
    );
    vi.mocked(handlePreApiCompaction).mockImplementation((history) =>
      Promise.resolve({ chatHistory: history, wasCompacted: false }),
    );
    resetAgentLoopLimits();
  });

  it("doesn't compact before a run's final call", async () => {
    // The limit left room for one call: a summary would be a second one, and
    // the request for the answer would go into it
    configureAgentLoopLimits({ maxTurns: "1" });
    const { handlePreApiCompaction } = await import(
      "./streamChatResponse.compactionHelpers.js"
    );
    vi.mocked(handlePreApiCompaction).mockImplementation((history) =>
      Promise.resolve({ chatHistory: history, wasCompacted: true }),
    );
    const { services } = await import("../services/index.js");
    const llmApi = answering();

    await run(llmApi);

    expect(handlePreApiCompaction).not.toHaveBeenCalled();
    expect(llmApi.chatCompletionStream).toHaveBeenCalledTimes(1);
    expect(vi.mocked(services.chatHistory.addUserMessage).mock.calls).toEqual([
      [expect.stringContaining("Stop working now")],
    ]);
  });

  it("takes the answer after a pre-call compaction without asking again", async () => {
    const { handlePreApiCompaction } = await import(
      "./streamChatResponse.compactionHelpers.js"
    );
    vi.mocked(handlePreApiCompaction).mockImplementation((history) =>
      Promise.resolve({ chatHistory: history, wasCompacted: true }),
    );
    const llmApi = answering();

    await run(llmApi);

    expect(llmApi.chatCompletionStream).toHaveBeenCalledTimes(1);
  });
});

describe("streamChatResponse - empty final turn when an answer is required", () => {
  const model = {
    provider: "openai",
    name: "gpt-4",
    model: "gpt-4",
    defaultCompletionOptions: { contextLength: 8192, maxTokens: 2048 },
  } as any;

  function chunk(content: string): ChatCompletionChunk {
    return {
      id: "test",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "test-model",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    };
  }

  async function run(replies: string[], required: boolean) {
    const { services } = await import("../services/index.js");
    requireFinalAnswer(required);
    const sent: string[] = [];
    vi.mocked(services.chatHistory.addUserMessage).mockImplementation((msg) => {
      sent.push(msg);
      return { message: { role: "user", content: msg }, contextItems: [] };
    });
    let calls = 0;
    const llmApi = {
      chatCompletionStream: vi.fn().mockImplementation(async function* () {
        const reply = replies[calls++] ?? "";
        if (reply) {
          yield chunk(reply);
        }
      }),
    } as unknown as BaseLlmApi;
    const response = await streamChatResponse(
      convertToUnifiedHistory([{ role: "user", content: "Review this" }]),
      model,
      llmApi,
      { signal: { aborted: false }, abort: vi.fn() } as any,
    );
    return { response, calls, sent };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const { handleNormalAutoCompaction } = await import(
      "./streamChatResponse.compactionHelpers.js"
    );
    vi.mocked(handleNormalAutoCompaction).mockImplementation((history) =>
      Promise.resolve({ chatHistory: history, wasCompacted: false }),
    );
    const { handleToolCalls } = await import("./handleToolCalls.js");
    vi.mocked(handleToolCalls).mockResolvedValue(false);
  });

  afterEach(() => {
    requireFinalAnswer(false);
  });

  it("asks once for the answer and returns it", async () => {
    const { response, calls, sent } = await run(
      ["", '{"verdict":"PASS"}'],
      true,
    );

    expect(sent).toEqual([EMPTY_ANSWER_PROMPT]);
    expect(calls).toBe(2);
    expect(response).toBe('{"verdict":"PASS"}');
  });

  it("asks only once when the answer stays empty", async () => {
    const { response, calls, sent } = await run(["", "", "never asked"], true);

    expect(sent).toEqual([EMPTY_ANSWER_PROMPT]);
    expect(calls).toBe(2);
    expect(response).toBe("");
  });

  it("does not ask when the first answer has text", async () => {
    const { response, calls, sent } = await run(["done"], true);

    expect(sent).toEqual([]);
    expect(calls).toBe(1);
    expect(response).toBe("done");
  });

  it("does not ask when no answer is required", async () => {
    const { calls, sent } = await run([""], false);

    expect(sent).toEqual([]);
    expect(calls).toBe(1);
  });
});
