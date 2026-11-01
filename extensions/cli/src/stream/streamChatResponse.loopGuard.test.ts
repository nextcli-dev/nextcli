import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import { convertToUnifiedHistory } from "core/util/messageConversion.js";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentLoopLimitError,
  configureAgentLoopLimits,
  resetAgentLoopLimits,
} from "./agentLoopLimits.js";
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
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
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

describe("streamChatResponse - agent loop limits", () => {
  const model = {
    provider: "openai",
    name: "gpt-4",
    model: "gpt-4",
    defaultCompletionOptions: { contextLength: 8192, maxTokens: 2048 },
  } as unknown as ModelConfig;
  let llmApi: BaseLlmApi;
  let modelCalls: number;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(sessionUsage, {
      promptTokens: 0,
      completionTokens: 0,
      totalCost: 0,
    });
    modelCalls = 0;
    llmApi = {
      chatCompletionStream: vi.fn().mockImplementation(async function* () {
        modelCalls++;
        // Each call uses 1000 tokens and $0.01
        sessionUsage.promptTokens += 900;
        sessionUsage.completionTokens += 100;
        sessionUsage.totalCost += 0.01;
        yield toolCallChunk();
      }),
    } as unknown as BaseLlmApi;
  });

  afterEach(() => {
    resetAgentLoopLimits();
  });

  const run = () =>
    streamChatResponse(
      convertToUnifiedHistory([{ role: "user", content: "Hello" }]),
      model,
      llmApi,
      { signal: { aborted: false }, abort: vi.fn() } as any,
    );

  it("stops after --max-turns model calls", async () => {
    configureAgentLoopLimits({ maxTurns: "3" });

    await expect(run()).rejects.toThrow(AgentLoopLimitError);
    await expect(run()).rejects.toThrow(/--max-turns/);
    expect(modelCalls).toBe(6);
  });

  it("stops at the default limit of 100 model calls", async () => {
    await expect(run()).rejects.toThrow("Stopped after 100 model calls");
    expect(modelCalls).toBe(100);
  });

  it("stops when --max-session-tokens is exceeded", async () => {
    configureAgentLoopLimits({ maxSessionTokens: "2500" });

    await expect(run()).rejects.toThrow(/--max-session-tokens/);
    expect(modelCalls).toBe(3);
  });

  it("stops when --max-cost is exceeded", async () => {
    configureAgentLoopLimits({ maxCost: "0.015" });

    await expect(run()).rejects.toThrow(/--max-cost/);
    expect(modelCalls).toBe(2);
  });

  it("does not count usage from before the run (resumed sessions)", async () => {
    Object.assign(sessionUsage, {
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalCost: 100,
    });
    configureAgentLoopLimits({ maxTurns: "2", maxSessionTokens: "5000" });

    await expect(run()).rejects.toThrow(/--max-turns/);
    expect(modelCalls).toBe(2);
  });

  it("rejects invalid limit values", () => {
    expect(() => configureAgentLoopLimits({ maxTurns: "zero" })).toThrow(
      "--max-turns must be a positive number",
    );
  });
});
