import { describe, expect, it } from "vitest";

import type { Usage } from "../..";

import { calculateRequestCost, CostBreakdown } from "./calculateRequestCost";

interface TestCase {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  expectedCost: number | null;
  description?: string;
}

describe("calculateRequestCost", () => {
  const testCases: TestCase[] = [
    // Current OpenAI models (prices checked 2026-11-01)
    {
      provider: "openai",
      model: "gpt-5.5",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.02,
      description: "GPT-5.5 basic usage",
    },
    {
      provider: "openai",
      model: "gpt-5.5-2026-04-23",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.02,
      description: "GPT-5.5 dated snapshot uses the GPT-5.5 price",
    },
    {
      provider: "openai",
      model: "gpt-5-mini",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.00125,
      description: "GPT-5 mini is not priced as GPT-5",
    },
    {
      provider: "openai",
      model: "gpt-6.1-sol",
      promptTokens: 10_000,
      completionTokens: 1000,
      cachedTokens: 8000,
      expectedCost: 0.0148,
      description: "GPT-6.1 Sol bills cached prompt tokens at the cached rate",
    },
    {
      provider: "openai",
      model: "gpt-5.4",
      promptTokens: 300_000,
      completionTokens: 1000,
      expectedCost: 1.5225,
      description: "GPT-5.4 long context pricing above 272K input tokens",
    },
    // Current Claude models (prices checked 2026-11-01)
    {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      promptTokens: 1000,
      completionTokens: 500,
      cachedTokens: 2000,
      expectedCost: 0.0072,
      description: "Claude Sonnet 5.5 with cache reads",
    },
    {
      provider: "anthropic",
      model: "claude-sonnet-5",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.007,
      description: "Claude Sonnet 5 is not priced as Sonnet 5.5",
    },
    {
      provider: "anthropic",
      model: "claude-opus-5-5",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.014,
      description: "Claude Opus 5.5 basic usage",
    },
    {
      provider: "anthropic",
      model: "claude-fable-5-1",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.035,
      description: "Claude Fable 5.1 basic usage",
    },
    {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      promptTokens: 50_000,
      completionTokens: 1000,
      expectedCost: 0.0055,
      description: "Claude Haiku 5.5 short prompt",
    },
    {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      promptTokens: 60_000,
      completionTokens: 1000,
      cachedTokens: 50_000,
      expectedCost: 0.035,
      description: "Claude Haiku 5.5 long prompt counts cache reads",
    },
    {
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.0035,
      description: "Claude Haiku 4.5 basic usage",
    },
    // Anthropic Claude 3.5 Sonnet
    {
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.0105,
      description: "Claude 3.5 Sonnet basic usage",
    },
    {
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      promptTokens: 1000,
      completionTokens: 500,
      cachedTokens: 2000,
      expectedCost: 0.0111,
      description: "Claude 3.5 Sonnet with cache reads",
    },
    {
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      promptTokens: 1000,
      completionTokens: 500,
      cacheWriteTokens: 300,
      expectedCost: 0.011625,
      description: "Claude 3.5 Sonnet with cache writes",
    },
    {
      provider: "anthropic",
      model: "claude-3-5-sonnet-20240620",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.0105,
      description: "Claude 3.5 Sonnet (older version)",
    },

    // Anthropic Claude 3.5 Haiku
    {
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.0028,
      description: "Claude 3.5 Haiku",
    },

    // Anthropic Claude 3 Haiku (legacy)
    {
      provider: "anthropic",
      model: "claude-3-haiku-20240307",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.000875,
      description: "Claude 3 Haiku legacy",
    },

    // Anthropic Claude 3 Opus
    {
      provider: "anthropic",
      model: "claude-3-opus-20240229",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.0525,
      description: "Claude 3 Opus",
    },

    // Anthropic Claude Opus 4.5
    {
      provider: "anthropic",
      model: "claude-opus-4-5-20251101",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.0175,
      description: "Claude Opus 4.5 basic usage",
    },
    {
      provider: "anthropic",
      model: "claude-opus-4-5-latest",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.0175,
      description: "Claude Opus 4.5 latest (partial match)",
    },
    {
      provider: "anthropic",
      model: "claude-opus-4-5-20251101",
      promptTokens: 1000,
      completionTokens: 500,
      cachedTokens: 2000,
      expectedCost: 0.0185,
      description: "Claude Opus 4.5 with cache reads",
    },
    {
      provider: "anthropic",
      model: "claude-opus-4-5-20251101",
      promptTokens: 1000,
      completionTokens: 500,
      cacheWriteTokens: 300,
      expectedCost: 0.019375,
      description: "Claude Opus 4.5 with cache writes",
    },

    // OpenAI GPT-4
    {
      provider: "openai",
      model: "gpt-4",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.06,
      description: "GPT-4 basic usage",
    },
    {
      provider: "openai",
      model: "gpt-4-turbo",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.025,
      description: "GPT-4 Turbo",
    },
    {
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.0075,
      description: "GPT-4o",
    },
    {
      provider: "openai",
      model: "gpt-4o-mini",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.00045,
      description: "GPT-4o-mini",
    },

    // OpenAI GPT-3.5
    {
      provider: "openai",
      model: "gpt-3.5-turbo-0125",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.00125,
      description: "GPT-3.5 Turbo",
    },

    // Edge cases
    {
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      promptTokens: 0,
      completionTokens: 0,
      expectedCost: 0,
      description: "Zero tokens",
    },
    {
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      promptTokens: 1000,
      completionTokens: 0,
      expectedCost: 0.003,
      description: "Only input tokens",
    },
    {
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      promptTokens: 0,
      completionTokens: 500,
      expectedCost: 0.0075,
      description: "Only output tokens",
    },

    // Case insensitivity
    {
      provider: "ANTHROPIC",
      model: "claude-3-5-sonnet-20241022",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: 0.0105,
      description: "Provider name case insensitive",
    },

    // Unknown models/providers
    {
      provider: "anthropic",
      model: "claude-unknown-model",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: null,
      description: "Unknown Anthropic model",
    },
    {
      provider: "google",
      model: "gemini-pro",
      promptTokens: 1000,
      completionTokens: 500,
      expectedCost: null,
      description: "Unknown provider",
    },
  ];

  testCases.forEach(
    ({
      provider,
      model,
      promptTokens,
      completionTokens,
      cachedTokens,
      cacheWriteTokens,
      expectedCost,
      description,
    }) => {
      it(description || `${provider}/${model}`, () => {
        const usage: Usage = {
          promptTokens,
          completionTokens,
          promptTokensDetails:
            cachedTokens || cacheWriteTokens
              ? {
                  cachedTokens,
                  cacheWriteTokens,
                }
              : undefined,
        };

        const result = calculateRequestCost(provider, model, usage);

        if (expectedCost === null) {
          expect(result).toBeNull();
        } else {
          expect(result).not.toBeNull();
          expect(result!.cost).toBeCloseTo(expectedCost, 6);
        }
      });
    },
  );
});

describe("calculateRequestCost by host", () => {
  const usage: Usage = { promptTokens: 1_000_000, completionTokens: 1_000_000 };
  const oneprovider = { apiBase: "https://api.oneprovider.dev/v1" };

  it("prices oneprovider models from its own table", () => {
    const result = calculateRequestCost(
      "openai",
      "deepseek-v4-pro",
      usage,
      oneprovider,
    );
    expect(result?.cost).toBeCloseTo(1.32 + 3.96, 6);
    expect(result?.priced).toBe("exact");
  });

  it("uses the oneprovider price over the OpenAI list price", () => {
    const result = calculateRequestCost(
      "openai",
      "gpt-5.6-sol",
      usage,
      oneprovider,
    );
    expect(result?.cost).toBeCloseTo(5 + 30, 6);
  });

  it("matches dated and thinking variants on oneprovider", () => {
    expect(
      calculateRequestCost("openai", "deepseek-v4-pro-0813", usage, oneprovider)
        ?.cost,
    ).toBeCloseTo(1.32 + 3.96, 6);
    expect(
      calculateRequestCost(
        "openai",
        "claude-haiku-4-5-20251001-thinking",
        usage,
        oneprovider,
      )?.cost,
    ).toBeCloseTo(1 + 5, 6);
  });

  it("does not price a different model that shares a prefix", () => {
    expect(
      calculateRequestCost("openai", "gpt-5.5-pro", usage, oneprovider),
    ).toBeNull();
  });

  it("bills cached tokens at the input price when the host lists none", () => {
    const result = calculateRequestCost(
      "openai",
      "deepseek-v4-pro",
      {
        promptTokens: 1_000_000,
        completionTokens: 0,
        promptTokensDetails: { cachedTokens: 500_000 },
      },
      oneprovider,
    );
    expect(result?.cost).toBeCloseTo(1.32, 6);
  });

  it("prices OpenRouter models from its catalog", () => {
    const result = calculateRequestCost(
      "openrouter",
      "deepseek/deepseek-v4-pro",
      usage,
    );
    expect(result?.cost).toBeCloseTo(0.3583 + 0.7165, 6);
    expect(result?.priced).toBe("exact");
  });

  it("recognizes OpenRouter by its host", () => {
    const result = calculateRequestCost(
      "openai",
      "anthropic/claude-opus-5.5",
      usage,
      { apiBase: "https://openrouter.ai/api/v1" },
    );
    expect(result?.cost).toBeCloseTo(4 + 20, 6);
  });

  it("returns null for an unknown model unless asked to estimate", () => {
    const deepseek = { apiBase: "https://api.deepseek.example/v1" };
    expect(
      calculateRequestCost("openai", "deepseek-v4-pro", usage, deepseek),
    ).toBeNull();

    const estimate = calculateRequestCost("openai", "deepseek-v4-pro", usage, {
      ...deepseek,
      estimateUnknown: true,
    });
    expect(estimate?.cost).toBeCloseTo(0.3583 + 0.7165, 6);
    expect(estimate?.priced).toBe("estimated");
  });

  it("matches maker names to OpenRouter names when estimating", () => {
    const dashed = calculateRequestCost("gemini", "claude-opus-5-5", usage, {
      estimateUnknown: true,
    });
    const dotted = calculateRequestCost("gemini", "claude-opus-5.5", usage, {
      estimateUnknown: true,
    });
    expect(dashed?.cost).toBeCloseTo(4 + 20, 6);
    expect(dotted?.cost).toBeCloseTo(dashed!.cost, 6);
    expect(dotted?.priced).toBe("estimated");
  });

  it("never estimates for local hosts", () => {
    expect(
      calculateRequestCost("ollama", "deepseek-v4-pro", usage, {
        apiBase: "http://localhost:11434",
        estimateUnknown: true,
      }),
    ).toBeNull();
  });

  it("returns null when no table knows the model", () => {
    expect(
      calculateRequestCost("openai", "my-private-model", usage, {
        estimateUnknown: true,
      }),
    ).toBeNull();
  });
});
