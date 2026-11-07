import { describe, expect, it } from "vitest";

import {
  estimateFinalAnswerCost,
  FINAL_ANSWER_TOKENS,
  finalAnswerMaxTokens,
  MIN_FINAL_ANSWER_TOKENS,
  priceRequest,
  SHORT_FINAL_ANSWER_TOKENS,
} from "./streamChatResponse.helpers.js";

// gpt-4 costs $30 per million input tokens and $60 per million output tokens
const gpt4 = {
  provider: "openai",
  model: "gpt-4",
  defaultCompletionOptions: { contextLength: 128_000, maxTokens: 50_000 },
};

const oneproviderDeepseek = {
  provider: "openai",
  model: "deepseek-v4-pro",
  apiBase: "https://api.oneprovider.dev/v1",
};

describe("priceRequest", () => {
  it("prices oneprovider models exactly", () => {
    const price = priceRequest(oneproviderDeepseek, {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(price.cost).toBeCloseTo(1.32 + 3.96, 6);
    expect(price.priced).toBe("exact");
  });

  it("estimates unknown hosts from OpenRouter prices", () => {
    const price = priceRequest(
      { ...oneproviderDeepseek, apiBase: "https://llm.example.com/v1" },
      { promptTokens: 1_000_000, completionTokens: 0 },
    );
    expect(price.priced).toBe("estimated");
  });

  it("falls back to $1/$2 per million tokens", () => {
    const price = priceRequest(
      { provider: "openai", model: "my-private-model" },
      { promptTokens: 1_000_000, completionTokens: 1_000_000 },
    );
    expect(price.cost).toBeCloseTo(3, 6);
    expect(price.priced).toBe("fallback");
  });

  it("never estimates local models", () => {
    const price = priceRequest(
      { provider: "ollama", model: "deepseek-v4-pro" },
      { promptTokens: 1_000_000, completionTokens: 0 },
    );
    expect(price.priced).toBe("fallback");
  });
});

describe("finalAnswerMaxTokens", () => {
  it("does not limit runs without a cost limit", () => {
    expect(finalAnswerMaxTokens(gpt4, undefined, 10_000)).toBeUndefined();
  });

  it("allows the output the money left buys after the prompt", () => {
    // $1 left, the prompt costs $0.30, output costs $0.00006 per token
    expect(finalAnswerMaxTokens(gpt4, 1, 10_000)).toBe(11_666);
  });

  it("caps a nearly exhausted budget instead of buying a full completion", () => {
    expect(finalAnswerMaxTokens(gpt4, 0.01, 10_000)).toBe(
      SHORT_FINAL_ANSWER_TOKENS,
    );
    expect(finalAnswerMaxTokens(gpt4, -0.5, 10_000)).toBe(
      SHORT_FINAL_ANSWER_TOKENS,
    );
    expect(SHORT_FINAL_ANSWER_TOKENS).toBeLessThan(MIN_FINAL_ANSWER_TOKENS);
  });

  it("allows at most the tokens kept for a final answer", () => {
    expect(finalAnswerMaxTokens(gpt4, 100, 10_000)).toBe(FINAL_ANSWER_TOKENS);
  });

  it("never exceeds the model's own output limit", () => {
    const small = {
      ...gpt4,
      defaultCompletionOptions: { contextLength: 128_000, maxTokens: 8000 },
    };
    expect(finalAnswerMaxTokens(small, 100, 10_000)).toBe(8000);
  });

  it("estimates a final answer's cost with the tokens kept for it", () => {
    // 10k prompt tokens at $30 and 16k output tokens at $60 per million
    expect(estimateFinalAnswerCost(gpt4, 10_000)).toBeCloseTo(0.3 + 0.96, 6);
  });

  it("does not buy a thinking budget the cost limit cannot pay for", () => {
    const thinking = {
      ...gpt4,
      defaultCompletionOptions: {
        ...gpt4.defaultCompletionOptions,
        reasoningBudgetTokens: 8000,
      },
    };
    expect(finalAnswerMaxTokens(thinking, 0.01, 10_000)).toBe(
      SHORT_FINAL_ANSWER_TOKENS,
    );
  });
});
