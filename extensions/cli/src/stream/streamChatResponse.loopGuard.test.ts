import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import { convertToUnifiedHistory } from "core/util/messageConversion.js";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { services } from "../services/index.js";

import {
  AgentLoopLimitError,
  checkAgentLoopLimits,
  configureAgentLoopLimits,
  getLimitReached,
  resetAgentLoopLimits,
} from "./agentLoopLimits.js";
import { getRequestTools, handleToolCalls } from "./handleToolCalls.js";
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
  countTotalInputTokens: vi.fn(() => 1000),
  getModelMaxTokens: vi.fn(() => 100_000),
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

// A model stuck in a loop: every response asks for the same tool again
function toolCallChunk(): ChatCompletionChunk {
  return {
    id: "test",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "test-model",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: `call_${Math.random()}`,
              type: "function",
              function: { name: "Read", arguments: '{"filepath":"a.ts"}' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

// The wrap-up call has no tools, so the model answers instead
function contentChunk(text: string): ChatCompletionChunk {
  return {
    id: "test",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "test-model",
    choices: [
      {
        index: 0,
        delta: { content: text },
        finish_reason: null,
      },
    ],
  };
}

const fakeTool = {
  type: "function",
  function: { name: "Read", parameters: { type: "object" } },
};

describe("streamChatResponse - agent loop limits", () => {
  const model = {
    provider: "openai",
    name: "gpt-4",
    model: "gpt-4",
    defaultCompletionOptions: { contextLength: 8192, maxTokens: 2048 },
  } as unknown as ModelConfig;
  let llmApi: BaseLlmApi;
  let modelCalls: number;
  let callsWithoutTools: number;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRequestTools).mockResolvedValue([fakeTool] as any);
    Object.assign(sessionUsage, {
      promptTokens: 0,
      completionTokens: 0,
      totalCost: 0,
    });
    modelCalls = 0;
    callsWithoutTools = 0;
    llmApi = {
      chatCompletionStream: vi.fn().mockImplementation(async function* (body: {
        tools?: unknown[];
      }) {
        modelCalls++;
        // Each call uses 1000 tokens and $0.01
        sessionUsage.promptTokens += 900;
        sessionUsage.completionTokens += 100;
        sessionUsage.totalCost += 0.01;
        if (body.tools) {
          yield toolCallChunk();
        } else {
          callsWithoutTools++;
          yield contentChunk("Final answer");
        }
      }),
    } as unknown as BaseLlmApi;
  });

  afterEach(() => {
    resetAgentLoopLimits();
  });

  const run = (runModel: ModelConfig = model) =>
    streamChatResponse(
      convertToUnifiedHistory([{ role: "user", content: "Hello" }]),
      runModel,
      llmApi,
      { signal: { aborted: false }, abort: vi.fn() } as any,
    );

  // $0.10 per million input tokens and $0.50 per million output tokens, so a
  // final answer (1000 prompt tokens, 16k output) costs about $0.008
  const cheapModel = {
    ...model,
    model: "gpt-6-luna",
  } as unknown as ModelConfig;

  const wrapUpPrompt = () =>
    vi.mocked(services.chatHistory.addUserMessage).mock.calls.at(-1)?.[0];

  it("makes the last allowed call a final answer without tools", async () => {
    configureAgentLoopLimits({ maxTurns: "3" });

    await expect(run()).resolves.toBe("Final answer");
    expect(modelCalls).toBe(3);
    expect(callsWithoutTools).toBe(1);
    expect(wrapUpPrompt()).toMatch(/--max-turns/);
    expect(wrapUpPrompt()).toMatch(/do not call any tools/);
    expect(getLimitReached()).toBe("turns");
  });

  it("stops at the default limit of 100 model calls", async () => {
    await expect(run()).resolves.toBe("Final answer");
    expect(modelCalls).toBe(100);
    expect(callsWithoutTools).toBe(1);
  });

  it("wraps up when the tokens left would not cover two more calls", async () => {
    configureAgentLoopLimits({ maxSessionTokens: "2500" });

    // After one call, 1500 tokens are left: less than twice the last call
    await expect(run()).resolves.toBe("Final answer");
    expect(modelCalls).toBe(2);
    expect(wrapUpPrompt()).toMatch(/--max-session-tokens/);
    expect(getLimitReached()).toBe("tokens");
  });

  it("wraps up before --max-cost is exceeded", async () => {
    configureAgentLoopLimits({ maxCost: "0.055" });

    // After four calls, $0.015 is left: less than twice the last call
    await expect(run(cheapModel)).resolves.toBe("Final answer");
    expect(modelCalls).toBe(5);
    expect(sessionUsage.totalCost).toBeLessThanOrEqual(0.055);
    expect(wrapUpPrompt()).toMatch(/--max-cost/);
    expect(getLimitReached()).toBe("cost");

    // Only the final answer has an output limit: the $0.015 left buys more
    // than the 16k tokens a final answer gets
    const calls = vi.mocked(llmApi.chatCompletionStream).mock.calls;
    expect(calls.at(-1)?.[0]).toMatchObject({ max_tokens: 16_000 });
    expect(calls[0][0]).not.toHaveProperty("max_tokens", 16_000);
  });

  it("answers at once when the limit can't cover more than a final answer", async () => {
    configureAgentLoopLimits({ maxCost: "0.5" });

    // On gpt-4 ($30/$60 per million) a 16k final answer costs about $0.99
    await expect(run()).resolves.toBe("Final answer");
    expect(modelCalls).toBe(1);
    expect(callsWithoutTools).toBe(1);

    // What $0.50 buys after a $0.03 prompt, at $60 per million output tokens
    const calls = vi.mocked(llmApi.chatCompletionStream).mock.calls;
    expect(calls[0][0]).toMatchObject({ max_tokens: 7833 });
  });

  it("turns thinking off for the final call only, on a model that can", async () => {
    // What nextcli-checks configures: OpenAI-compatible, pointed at OneProvider
    const deepseek = {
      provider: "openai",
      name: "checks",
      model: "deepseek-v4-pro",
      apiBase: "https://api.oneprovider.dev/v1",
      defaultCompletionOptions: { contextLength: 100_000, maxTokens: 2048 },
    } as unknown as ModelConfig;
    configureAgentLoopLimits({ maxTurns: "3" });

    await expect(run(deepseek)).resolves.toBe("Final answer");

    const calls = vi.mocked(llmApi.chatCompletionStream).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0][0]).not.toHaveProperty("thinking");
    expect(calls[1][0]).not.toHaveProperty("thinking");
    expect(calls[2][0]).toMatchObject({
      thinking: { type: "disabled" },
      reasoning_effort: "none",
    });
    expect(calls[1][0]).not.toHaveProperty("reasoning_effort");
    expect(calls[2][0].tools).toBeUndefined();
  });

  it("drops tool calls in the final answer", async () => {
    configureAgentLoopLimits({ maxTurns: "1" });
    vi.mocked(llmApi.chatCompletionStream).mockImplementation(
      async function* () {
        modelCalls++;
        yield contentChunk("Partial answer");
        yield toolCallChunk();
      } as any,
    );

    await expect(run()).resolves.toBe("Partial answer");
    expect(handleToolCalls).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handleToolCalls).mock.calls[0][0].toolCalls).toEqual([]);
  });

  it("does not count usage from before the run (resumed sessions)", async () => {
    Object.assign(sessionUsage, {
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalCost: 100,
    });
    configureAgentLoopLimits({ maxTurns: "2", maxSessionTokens: "5000" });

    await expect(run()).resolves.toBe("Final answer");
    expect(modelCalls).toBe(2);
    expect(getLimitReached()).toBe("turns");
  });

  it("does not spend another call when the previous one already passed the cost limit", async () => {
    configureAgentLoopLimits({ maxCost: "0.02" });
    vi.mocked(llmApi.chatCompletionStream).mockImplementation(
      async function* () {
        modelCalls++;
        sessionUsage.promptTokens += 900;
        sessionUsage.completionTokens += 100;
        sessionUsage.totalCost += 0.03;
        yield toolCallChunk();
      } as any,
    );

    await expect(run(cheapModel)).rejects.toBeInstanceOf(AgentLoopLimitError);
    expect(modelCalls).toBe(1);
    expect(getLimitReached()).toBe("cost");
  });

  it("reports no limit when the run finishes on its own", async () => {
    configureAgentLoopLimits({ maxTurns: "5" });
    vi.mocked(llmApi.chatCompletionStream).mockImplementation(
      async function* () {
        modelCalls++;
        yield contentChunk("Done");
      } as any,
    );

    await expect(run()).resolves.toBe("Done");
    expect(modelCalls).toBe(1);
    expect(getLimitReached()).toBeUndefined();
  });

  it("rejects invalid limit values", () => {
    expect(() => configureAgentLoopLimits({ maxTurns: "zero" })).toThrow(
      "--max-turns must be a positive number",
    );
  });
});

describe("checkAgentLoopLimits", () => {
  const start = { tokens: 0, cost: 0 };

  afterEach(() => {
    resetAgentLoopLimits();
  });

  it("keeps 10% of the budget for the first call", () => {
    Object.assign(sessionUsage, { promptTokens: 0, completionTokens: 0 });
    const limits = { maxTurns: 100, maxIdenticalToolCalls: 2, maxCostUsd: 1 };

    sessionUsage.totalCost = 0.89;
    expect(checkAgentLoopLimits(limits, 2, start, undefined)).toBeUndefined();

    sessionUsage.totalCost = 0.91;
    expect(checkAgentLoopLimits(limits, 2, start, undefined)?.limit).toBe(
      "cost",
    );
  });

  it("keeps twice the last call when that is more", () => {
    Object.assign(sessionUsage, { promptTokens: 0, completionTokens: 0 });
    const limits = { maxTurns: 100, maxIdenticalToolCalls: 2, maxCostUsd: 1 };
    sessionUsage.totalCost = 0.5;

    expect(
      checkAgentLoopLimits(limits, 2, start, { tokens: 0, cost: 0.2 }),
    ).toBeUndefined();
    expect(
      checkAgentLoopLimits(limits, 2, start, { tokens: 0, cost: 0.3 })?.limit,
    ).toBe("cost");
  });

  it("wraps up on the last allowed turn and stops after it", () => {
    const limits = { maxTurns: 3, maxIdenticalToolCalls: 2 };

    expect(
      checkAgentLoopLimits(limits, 2, undefined, undefined),
    ).toBeUndefined();
    expect(checkAgentLoopLimits(limits, 3, undefined, undefined)).toEqual({
      limit: "turns",
      description: expect.stringMatching(/--max-turns/),
    });
    expect(checkAgentLoopLimits(limits, 4, undefined, undefined)?.stop).toBe(
      true,
    );
  });

  it("wraps up when tokens left are under the reserve and stops when none are left", () => {
    Object.assign(sessionUsage, { promptTokens: 0, completionTokens: 0 });
    const limits = {
      maxTurns: 100,
      maxIdenticalToolCalls: 2,
      maxSessionTokens: 1000,
    };

    sessionUsage.promptTokens = 800;
    expect(checkAgentLoopLimits(limits, 2, start, undefined)).toBeUndefined();

    const wrapUp = checkAgentLoopLimits(limits, 2, start, {
      tokens: 150,
      cost: 0,
    });
    expect(wrapUp?.limit).toBe("tokens");
    expect(wrapUp?.stop).toBeUndefined();

    sessionUsage.promptTokens = 1000;
    const stop = checkAgentLoopLimits(limits, 2, start, {
      tokens: 150,
      cost: 0,
    });
    expect(stop?.limit).toBe("tokens");
    expect(stop?.stop).toBe(true);
  });

  it("stops when the cost limit is already spent", () => {
    Object.assign(sessionUsage, { promptTokens: 0, completionTokens: 0 });
    const limits = { maxTurns: 100, maxIdenticalToolCalls: 2, maxCostUsd: 1 };
    sessionUsage.totalCost = 1;

    const stop = checkAgentLoopLimits(limits, 2, start, {
      tokens: 0,
      cost: 0.2,
    });
    expect(stop?.limit).toBe("cost");
    expect(stop?.stop).toBe(true);
  });
});
