import { describe, expect, it } from "vitest";

import { calculateRequestCost } from "./calculateRequestCost";

/**
 * What popular models cost for one typical review turn: 60K prompt tokens,
 * 40K of them cache reads, and 4K output. A catalog sync (npm run
 * sync-models) that moves a price, or its label, shows up here as a
 * snapshot diff, for review. Update with `npx vitest run -u` once checked.
 */
const MODELS: Array<[string, string, string?]> = [
  ["anthropic", "claude-opus-5-5"],
  ["anthropic", "claude-sonnet-5-5"],
  ["anthropic", "claude-haiku-5-5"],
  ["anthropic", "claude-sonnet-4-5"],
  ["anthropic", "claude-sonnet-5-5", "https://llm-proxy.example.com"],
  ["openai", "gpt-5.5"],
  ["openai", "gpt-5.4-mini"],
  ["openai", "gpt-5-pro"],
  ["openai", "gpt-6.1-terra"],
  ["openai", "gpt-4.1"],
  ["openai", "gpt-4.1-mini"],
  ["openai", "gpt-4o-2024-08-06"],
  ["openai", "o3"],
  ["openai", "gpt-5.5", "https://openpaths.io/v1"],
  ["gemini", "gemini-3.5-flash"],
  ["xAI", "grok-4.7"],
  ["deepseek", "deepseek-v4-pro"],
  ["groq", "openai/gpt-oss-120b"],
  ["groq", "allam-2-7b"],
  ["openai", "llama-3.3-70b-versatile", "https://api.groq.com/openai/v1"],
  ["openrouter", "anthropic/claude-sonnet-4.5"],
  ["openrouter", "anthropic/claude-sonnet-4.5:nitro"],
  ["openrouter", "deepseek/deepseek-v4-pro"],
  ["oneprovider", "claude-opus-5-5"],
  ["oneprovider", "deepseek-v4-pro"],
  ["moonshot", "kimi-k3"],
  ["mistral", "mistral-medium"],
  ["openai", "claude-opus-5-5", "http://127.0.0.1:8091/v1"],
  ["openai", "my-private-model", "http://127.0.0.1:8091/v1"],
  ["ollama", "qwen3-coder"],
];

describe("prices of popular models", () => {
  it("match the reviewed snapshot", () => {
    const usage = {
      promptTokens: 60_000,
      completionTokens: 4_000,
      promptTokensDetails: { cachedTokens: 40_000 },
    };
    const prices = Object.fromEntries(
      MODELS.map(([provider, model, apiBase]) => {
        const result = calculateRequestCost(provider, model, usage, {
          apiBase,
          estimateUnknown: true,
        });
        const key = apiBase
          ? `${provider} ${model} @ ${apiBase}`
          : `${provider} ${model}`;
        return [
          key,
          result
            ? { cost: Number(result.cost.toFixed(6)), priced: result.priced }
            : null,
        ];
      }),
    );
    expect(prices).toMatchSnapshot();
  });
});
