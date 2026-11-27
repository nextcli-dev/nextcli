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

async function run(
  model: Partial<ModelConfig>,
  chunks: unknown[],
  failWith?: Error,
) {
  const before = getSessionUsage();
  const llmApi = {
    chatCompletionStream: vi.fn().mockImplementation(async function* () {
      yield* chunks;
      if (failWith) throw failWith;
    }),
  } as unknown as BaseLlmApi;
  const call = processStreamingResponse({
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
  if (failWith) {
    await expect(call).rejects.toThrow(failWith.message);
  } else {
    await call;
  }
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

  const claude = { provider: "anthropic", model: "claude-sonnet-5-5" };

  it("counts encrypted reasoning, which a call without a summary streams as its only output", async () => {
    // 4000 characters of encrypted reasoning, about 1000 tokens
    const spent = await run(claude, [
      chunk({
        reasoning_details: [
          { type: "reasoning.encrypted", data: "x".repeat(4000), index: 0 },
        ],
      }),
    ]);
    expect(spent.completionTokens).toBeGreaterThanOrEqual(1000);
  });

  it("counts a tool call's name and arguments", async () => {
    const toolCall = (name: string) =>
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name, arguments: '{"filepath":"src/index.ts"}' },
          },
        ],
      });
    const short = await run(claude, [toolCall("Read")]);
    const long = await run(claude, [
      toolCall("ReadTheWholeRepositoryFileByFile"),
    ]);
    expect(short.completionTokens).toBeGreaterThan(0);
    expect(long.completionTokens).toBeGreaterThan(short.completionTokens);
  });

  it("scales the output for the model, as the prompt count is", async () => {
    // Claude's tokenizer makes more tokens of the same text than the one
    // the CLI counts with, and the prompt count corrects for it
    const gpt = await run({ provider: "openai", model: "gpt-6.1-sol" }, answer);
    const sonnet = await run(claude, answer);
    expect(sonnet.completionTokens).toBeGreaterThan(gpt.completionTokens);
  });

  it("prices an all-zero usage object like a missing one", async () => {
    const spent = await run(claude, [
      ...answer,
      chunk({}, { prompt_tokens: 0, completion_tokens: 0 }),
    ]);
    expect(spent.cost).toBeGreaterThan(0);
    expect(getPriceSource()).toBe("estimated");
  });

  // A disconnect after some output: the attempt is recorded by the
  // discarded-attempt hook, with the same estimate as a finished call
  it("prices a stream that fails before its usage chunk", async () => {
    const finished = await run(claude, answer);
    const failed = await run(
      claude,
      answer,
      Object.assign(new Error("connection reset"), { status: 400 }),
    );
    expect(failed.completionTokens).toBe(finished.completionTokens);
    expect(failed.cost).toBeCloseTo(finished.cost, 10);
  });

  it("counts special-token text in a failed attempt instead of throwing", async () => {
    const failed = await run(
      claude,
      [chunk({ content: "The tokenizer file holds <|endoftext|> markers." })],
      Object.assign(new Error("connection reset"), { status: 400 }),
    );
    expect(failed.completionTokens).toBeGreaterThan(0);
  });
});
