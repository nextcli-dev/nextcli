import { describe, expect, it } from "vitest";

import {
  findCatalogCost,
  findCatalogFastCost,
  findGeneralCost,
} from "@nextcli/llm-info";

import type { Usage } from "../..";

import {
  calculateRequestCost,
  CostBreakdown,
  unknownZeroPriceWarning,
} from "./calculateRequestCost";
import { priceWithHostRates } from "./rates/hostRates";

interface TestCase {
  provider: string;
  model: string;
  /** Every input token, cached ones included, as every adapter reports it */
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
      promptTokens: 3000,
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
      promptTokens: 110_000,
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
      promptTokens: 3000,
      completionTokens: 500,
      cachedTokens: 2000,
      expectedCost: 0.0111,
      description: "Claude 3.5 Sonnet with cache reads",
    },
    {
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      promptTokens: 1300,
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
      promptTokens: 3000,
      completionTokens: 500,
      cachedTokens: 2000,
      expectedCost: 0.0185,
      description: "Claude Opus 4.5 with cache reads",
    },
    {
      provider: "anthropic",
      model: "claude-opus-4-5-20251101",
      promptTokens: 1300,
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

  // Prices from the models.dev snapshot (npm run sync-models) are read from
  // it here, so a new snapshot doesn't need new numbers in these tests
  const openRouterDeepSeek = findCatalogCost(
    "openrouter",
    "deepseek/deepseek-v4-pro",
  )!;

  it("prices OpenRouter models from its catalog", () => {
    const result = calculateRequestCost(
      "openrouter",
      "deepseek/deepseek-v4-pro",
      usage,
    );
    expect(result?.cost).toBeCloseTo(
      openRouterDeepSeek.input + openRouterDeepSeek.output,
      6,
    );
    expect(result?.priced).toBe("catalog");
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
    const general = findGeneralCost("deepseek-v4-pro")!;
    expect(estimate?.cost).toBeCloseTo(general.input + general.output, 6);
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

  it("never estimates for a local model server on this machine", () => {
    for (const [provider, apiBase] of [
      ["ollama", "http://localhost:11434"],
      ["ollama", undefined],
      ["vllm", "http://127.0.0.1:8000/v1"],
      ["lmstudio", "http://localhost:1234/v1"],
    ]) {
      expect(
        calculateRequestCost(provider!, "deepseek-v4-pro", usage, {
          apiBase,
          estimateUnknown: true,
        }),
        `${provider} ${apiBase}`,
      ).toBeNull();
    }
  });

  it("estimates a local server's provider on a public host", () => {
    // ollama.com serves paid models through the same provider
    expect(
      calculateRequestCost("ollama", "deepseek-v4-pro", usage, {
        apiBase: "https://ollama.com",
        estimateUnknown: true,
      })?.priced,
    ).toBe("estimated");
  });

  it("marks a maker's list price estimated on any host but the maker's", () => {
    const gateway = {
      apiBase: "https://openpaths.io/v1",
      estimateUnknown: true,
    };
    const listPrice = calculateRequestCost("openai", "gpt-4o", usage);
    expect(listPrice?.priced).toBe("exact");
    const onGateway = calculateRequestCost("openai", "gpt-4o", usage, gateway);
    expect(onGateway?.priced).toBe("estimated");
    expect(onGateway?.cost).toBeCloseTo(listPrice!.cost, 6);
    expect(
      calculateRequestCost("anthropic", "claude-sonnet-5-5", usage, {
        apiBase: "https://llm-proxy.example.com",
      })?.priced,
    ).toBe("estimated");
    // The makers' own APIs stay exact
    expect(
      calculateRequestCost("openai", "gpt-4o", usage, {
        apiBase: "https://api.openai.com/v1",
      })?.priced,
    ).toBe("exact");
    expect(
      calculateRequestCost("anthropic", "claude-sonnet-5-5", usage, {
        apiBase: "https://api.anthropic.com/v1",
      })?.priced,
    ).toBe("exact");
  });

  it("bills a fast request at the fast price", () => {
    const fast = findCatalogFastCost("openai", "gpt-5.5")!;
    const result = calculateRequestCost("openai", "gpt-5.5", usage, {
      fast: true,
    });
    expect(result?.cost).toBeCloseTo(fast.input + fast.output, 6);
    expect(result?.priced).toBe("catalog");
    expect(result!.cost).toBeGreaterThan(
      calculateRequestCost("openai", "gpt-5.5", usage)!.cost,
    );
    // Claude's fast mode too
    const claudeFast = findCatalogFastCost("anthropic", "claude-opus-5-5")!;
    expect(
      calculateRequestCost("anthropic", "claude-opus-5-5", usage, {
        fast: true,
      })?.cost,
    ).toBeCloseTo(claudeFast.input + claudeFast.output, 6);
  });

  it("marks a fast request estimated when its fast price isn't known", () => {
    const result = calculateRequestCost("oneprovider", "gpt-5.5", usage, {
      fast: true,
    });
    expect(result?.priced).toBe("estimated");
  });

  it("prices a provider's models from its own catalog entry", () => {
    const deepseek = findCatalogCost("deepseek", "deepseek-v4-pro")!;
    const result = calculateRequestCost("deepseek", "deepseek-v4-pro", usage);
    expect(result?.cost).toBeCloseTo(deepseek.input + deepseek.output, 6);
    expect(result?.priced).toBe("catalog");
    // Provider names are matched without case (xAI, zAI)
    expect(calculateRequestCost("xai", "grok-4.7", usage)?.priced).toBe(
      "catalog",
    );
  });

  it("prices provider oneprovider from its table without an API base", () => {
    const result = calculateRequestCost(
      "oneprovider",
      "deepseek-v4-pro",
      usage,
    );
    expect(result?.cost).toBeCloseTo(1.32 + 3.96, 6);
    expect(result?.priced).toBe("exact");
  });

  it("gives a custom gateway on a public host the general price", () => {
    const general = findGeneralCost("deepseek-v4-pro")!;
    const result = calculateRequestCost("openai", "deepseek-v4-pro", usage, {
      apiBase: "https://openpaths.io/v1",
      estimateUnknown: true,
    });
    expect(result?.cost).toBeCloseTo(general.input + general.output, 6);
    expect(result?.priced).toBe("estimated");
  });

  it("prices private-network hosts like any other host", () => {
    for (const apiBase of [
      "http://10.0.0.5:4000/v1",
      "http://172.20.1.2:8000/v1",
      "http://192.168.1.20:11434/v1",
      "http://gpu-box.local:8091/v1",
    ]) {
      expect(
        calculateRequestCost("openai", "deepseek-v4-pro", usage, {
          apiBase,
          estimateUnknown: true,
        })?.priced,
        apiBase,
      ).toBe("estimated");
    }
    // A local server's provider too: the machine isn't this one
    expect(
      calculateRequestCost("ollama", "deepseek-v4-pro", usage, {
        apiBase: "http://192.168.1.20:11434",
        estimateUnknown: true,
      })?.priced,
    ).toBe("estimated");
    expect(
      calculateRequestCost("anthropic", "claude-sonnet-5-5", usage, {
        apiBase: "http://10.0.0.5:4000",
      })?.priced,
    ).toBe("estimated");
  });

  it("gives no price to a bridge on this machine", () => {
    // NextCLI can't see which provider a bridge forwards to, so neither a
    // general price nor a maker's list price applies
    for (const [provider, model, apiBase] of [
      ["openai", "deepseek-v4-pro", "http://127.0.0.1:8091/v1"],
      ["openai", "gpt-4o", "http://localhost:8091/v1"],
      ["anthropic", "claude-sonnet-5-5", "http://[::1]:4000"],
    ]) {
      expect(
        calculateRequestCost(provider, model, usage, {
          apiBase,
          estimateUnknown: true,
        }),
        `${provider} ${model} ${apiBase}`,
      ).toBeNull();
    }
  });

  it("never prices a model at the catalog's $0 placeholder", () => {
    // Groq's allam-2-7b is listed at $0, which means unknown
    const result = calculateRequestCost("groq", "allam-2-7b", usage, {
      estimateUnknown: true,
    });
    expect(result?.cost ?? null).not.toBe(0);
    expect(result?.priced ?? "estimated").toBe("estimated");
    expect(unknownZeroPriceWarning("groq", "allam-2-7b")).toMatch(
      /allam-2-7b \(groq\) at \$0.*unknown, not that it is free/,
    );
    // OpenRouter's :free ids stay free, with no warning
    const free = calculateRequestCost(
      "openrouter",
      "google/gemma-4-31b-it:free",
      usage,
    );
    expect(free).toMatchObject({ cost: 0, priced: "catalog" });
    expect(
      unknownZeroPriceWarning("openrouter", "google/gemma-4-31b-it:free"),
    ).toBeUndefined();
    expect(
      unknownZeroPriceWarning("groq", "openai/gpt-oss-120b"),
    ).toBeUndefined();
  });

  it("prices Groq by its host under any provider name", () => {
    const groq = findCatalogCost("groq", "openai/gpt-oss-120b")!;
    for (const provider of ["openai", "groq"]) {
      expect(
        calculateRequestCost(provider, "openai/gpt-oss-120b", usage, {
          apiBase: "https://api.groq.com/openai/v1",
          estimateUnknown: true,
        }),
        provider,
      ).toMatchObject({
        cost: expect.closeTo(groq.input + groq.output, 6),
        priced: "catalog",
      });
    }
    expect(
      unknownZeroPriceWarning(
        "openai",
        "allam-2-7b",
        "https://api.groq.com/openai/v1",
      ),
    ).toBeDefined();
  });

  it("returns null when no table knows the model", () => {
    expect(
      calculateRequestCost("openai", "my-private-model", usage, {
        estimateUnknown: true,
      }),
    ).toBeNull();
  });
});

describe("priceWithHostRates", () => {
  const rates = {
    input: 2,
    output: 10,
    cachedInput: 0.2,
    cacheWrite: 2.5,
    tiers: [{ above: 200_000, input: 4, output: 15, cachedInput: 0.4 }],
  };

  it("bills cache reads and writes as parts of the prompt", () => {
    const { cost } = priceWithHostRates("m", rates, {
      promptTokens: 100_000,
      completionTokens: 10_000,
      promptTokensDetails: { cachedTokens: 60_000, cacheWriteTokens: 20_000 },
    });
    // 20K uncached, 60K cache reads, 20K cache writes, 10K output
    expect(cost).toBeCloseTo(0.04 + 0.012 + 0.05 + 0.1, 6);
  });

  it("uses the long-context tier once the prompt passes it", () => {
    const { cost } = priceWithHostRates("m", rates, {
      promptTokens: 300_000,
      completionTokens: 0,
    });
    expect(cost).toBeCloseTo(1.2, 6);
  });
});
