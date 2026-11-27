import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSessionUsage } from "../session.js";

import { getPriceSource, resetAgentLoopLimits } from "./agentLoopLimits.js";
import { processStreamingResponse } from "./streamChatResponse.js";

function chunk(delta: Record<string, unknown>, usage?: object) {
  return {
    id: "test",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: usage ? [] : [{ index: 0, delta, finish_reason: null }],
    ...(usage && { usage }),
  };
}

async function run(model: Partial<ModelConfig>, chunks: unknown[]) {
  const before = getSessionUsage();
  const llmApi = {
    chatCompletionStream: vi.fn().mockImplementation(async function* () {
      yield* chunks;
    }),
  } as unknown as BaseLlmApi;
  await processStreamingResponse({
    chatHistory: [
      {
        message: { role: "user", content: "Explain the failing test." },
        contextItems: [],
      },
    ],
    model: model as ModelConfig,
    llmApi,
    abortController: { signal: { aborted: false } } as AbortController,
    systemMessage: "You are a coding agent.",
    isHeadless: true,
  });
  const after = getSessionUsage();
  return {
    promptTokens: after.promptTokens - before.promptTokens,
    completionTokens: after.completionTokens - before.completionTokens,
    cost: after.totalCost - before.totalCost,
  };
}

const answer = [
  chunk({ content: "The test fails because the fixture path is wrong. " }),
  chunk({ content: "Fix the path in the setup file." }),
];

describe("a response that reports no usage", () => {
  beforeEach(() => {
    resetAgentLoopLimits();
  });

  // Bedrock sent none before its usage was read, and a stream cut off
  // before its usage chunk has none: --max-cost must still count the call
  it("is counted from the request and the streamed answer, at the model's price", async () => {
    const model = { provider: "anthropic", model: "claude-sonnet-5-5" };
    const spent = await run(model, answer);

    expect(spent.promptTokens).toBeGreaterThan(0);
    expect(spent.completionTokens).toBeGreaterThan(0);
    expect(spent.cost).toBeGreaterThan(0);
    expect(getPriceSource()).toBe("estimated");

    // The same tokens reported by the provider cost the same
    resetAgentLoopLimits();
    const reported = await run(model, [
      ...answer,
      chunk(
        {},
        {
          prompt_tokens: spent.promptTokens,
          completion_tokens: spent.completionTokens,
        },
      ),
    ]);
    expect(reported.cost).toBeCloseTo(spent.cost, 10);
    expect(getPriceSource()).not.toBe("estimated");
  });

  it("is never free for a model without a price", async () => {
    const spent = await run({ provider: "test", model: "test-model" }, answer);
    expect(spent.cost).toBeGreaterThan(0);
    expect(getPriceSource()).toBe("fallback");
  });
});
