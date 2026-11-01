import { Usage } from "../..";

export interface CostBreakdown {
  cost: number;
  breakdown: string;
}

interface AnthropicRates {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

interface AnthropicPricing extends AnthropicRates {
  longPrompt?: AnthropicRates & { thresholdTokens: number };
}

function calculateAnthropicCost(
  model: string,
  usage: Usage,
): CostBreakdown | null {
  // Normalize model name to handle various formats
  const normalizedModel = model.toLowerCase();

  // Define pricing per million tokens (MTok) by model family prefix.
  // Source: platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-01)
  const pricing: Record<string, AnthropicPricing> = {
    // Claude Fable 5.1
    "claude-fable-5-1": {
      input: 10,
      output: 50,
      cacheWrite: 12.5,
      cacheRead: 0.25,
    },

    // Claude Fable 5
    "claude-fable-5": {
      input: 10,
      output: 50,
      cacheWrite: 12.5,
      cacheRead: 1,
    },

    // Claude Opus 5.5
    "claude-opus-5-5": {
      input: 4,
      output: 20,
      cacheWrite: 5,
      cacheRead: 0.2,
    },

    // Claude Opus 5, 4.8 and 4.7
    "claude-opus-5": {
      input: 5,
      output: 25,
      cacheWrite: 6.25,
      cacheRead: 0.5,
    },
    "claude-opus-4-8": {
      input: 5,
      output: 25,
      cacheWrite: 6.25,
      cacheRead: 0.5,
    },
    "claude-opus-4-7": {
      input: 5,
      output: 25,
      cacheWrite: 6.25,
      cacheRead: 0.5,
    },

    // Claude Sonnet 5.5
    "claude-sonnet-5-5": {
      input: 2,
      output: 10,
      cacheWrite: 2.5,
      cacheRead: 0.1,
    },

    // Claude Sonnet 5
    "claude-sonnet-5": {
      input: 2,
      output: 10,
      cacheWrite: 2.5,
      cacheRead: 0.2,
    },

    // Claude Haiku 5.5: prompts over 100K tokens (cache reads and writes included) pay the higher prices
    "claude-haiku-5-5": {
      input: 0.1,
      output: 0.5,
      cacheWrite: 0.125,
      cacheRead: 0.01,
      longPrompt: {
        thresholdTokens: 100_000,
        input: 0.5,
        output: 2.5,
        cacheWrite: 0.625,
        cacheRead: 0.05,
      },
    },

    // Claude Sonnet 4.6
    "claude-sonnet-4-6": {
      input: 3,
      output: 15,
      cacheWrite: 3.75,
      cacheRead: 0.3,
    },

    // Claude Opus 4.6
    "claude-opus-4-6": {
      input: 5,
      output: 25,
      cacheWrite: 6.25,
      cacheRead: 0.5,
    },

    // Claude Opus 4.5 (previous generation)
    "claude-opus-4-5": {
      input: 5,
      output: 25,
      cacheWrite: 6.25,
      cacheRead: 0.5,
    },

    // Claude Sonnet 4.5
    "claude-sonnet-4-5": {
      input: 3,
      output: 15,
      cacheWrite: 3.75,
      cacheRead: 0.3,
    },

    // Claude Haiku 4.5
    "claude-haiku-4-5": {
      input: 1,
      output: 5,
      cacheWrite: 1.25,
      cacheRead: 0.1,
    },

    // Claude Opus 4 (legacy)
    "claude-3-opus": {
      input: 15,
      output: 75,
      cacheWrite: 18.75,
      cacheRead: 1.5,
    },

    // Claude Sonnet 4 (optimal balance)
    "claude-3-5-sonnet": {
      input: 3,
      output: 15,
      cacheWrite: 3.75,
      cacheRead: 0.3,
    },

    // Claude Haiku 3.5 (fastest, most cost-effective)
    "claude-3-5-haiku": {
      input: 0.8,
      output: 4,
      cacheWrite: 1,
      cacheRead: 0.08,
    },

    // Legacy Claude 3 Haiku
    "claude-3-haiku": {
      input: 0.25,
      output: 1.25,
      cacheWrite: 0.3,
      cacheRead: 0.03,
    },
  };

  // Sort keys by length (longest first) to match most specific patterns first
  const sortedKeys = Object.keys(pricing).sort((a, b) => b.length - a.length);

  let basePricing: AnthropicPricing | null = null;
  for (const prefix of sortedKeys) {
    if (normalizedModel.startsWith(prefix)) {
      basePricing = pricing[prefix];
      break;
    }
  }

  if (!basePricing) {
    return null; // Unknown model
  }

  const promptLength =
    usage.promptTokens +
    (usage.promptTokensDetails?.cachedTokens ?? 0) +
    (usage.promptTokensDetails?.cacheWriteTokens ?? 0);
  const modelPricing =
    basePricing.longPrompt &&
    promptLength > basePricing.longPrompt.thresholdTokens
      ? basePricing.longPrompt
      : basePricing;

  // Calculate costs
  const inputCost = (usage.promptTokens / 1_000_000) * modelPricing.input;
  const outputCost = (usage.completionTokens / 1_000_000) * modelPricing.output;

  // Build breakdown components
  const breakdownParts: string[] = [];

  // Input tokens breakdown
  if (usage.promptTokens > 0) {
    breakdownParts.push(
      `Input: ${usage.promptTokens.toLocaleString()} tokens × $${modelPricing.input}/MTok = $${inputCost.toFixed(6)}`,
    );
  }

  // Output tokens breakdown
  if (usage.completionTokens > 0) {
    breakdownParts.push(
      `Output: ${usage.completionTokens.toLocaleString()} tokens × $${modelPricing.output}/MTok = $${outputCost.toFixed(6)}`,
    );
  }

  // Handle prompt caching costs if available
  let cacheCost = 0;
  if (usage.promptTokensDetails) {
    const { cachedTokens, cacheWriteTokens } = usage.promptTokensDetails;

    if (cacheWriteTokens && cacheWriteTokens > 0) {
      const cacheWriteCost =
        (cacheWriteTokens / 1_000_000) * modelPricing.cacheWrite;
      cacheCost += cacheWriteCost;
      breakdownParts.push(
        `Cache Write: ${cacheWriteTokens.toLocaleString()} tokens × $${modelPricing.cacheWrite}/MTok = $${cacheWriteCost.toFixed(6)}`,
      );
    }

    if (cachedTokens && cachedTokens > 0) {
      const cacheReadCost = (cachedTokens / 1_000_000) * modelPricing.cacheRead;
      cacheCost += cacheReadCost;
      breakdownParts.push(
        `Cache Read: ${cachedTokens.toLocaleString()} tokens × $${modelPricing.cacheRead}/MTok = $${cacheReadCost.toFixed(6)}`,
      );
    }
  }

  const totalCost = inputCost + outputCost + cacheCost;

  // Build final breakdown string
  let breakdown = `Model: ${model}\n`;
  breakdown += breakdownParts.join("\n");
  if (breakdownParts.length > 1) {
    breakdown += `\nTotal: $${totalCost.toFixed(6)}`;
  }

  return {
    cost: totalCost,
    breakdown,
  };
}

interface OpenAIRates {
  input: number;
  output: number;
  cachedInput?: number;
}

interface OpenAIPricing extends OpenAIRates {
  // Prices for requests with more than OPENAI_LONG_CONTEXT_TOKENS input tokens
  longContext?: OpenAIRates;
}

const OPENAI_LONG_CONTEXT_TOKENS = 272_000;

function calculateOpenAICost(
  model: string,
  usage: Usage,
): CostBreakdown | null {
  // Normalize model name
  const normalizedModel = model.toLowerCase();

  // Define pricing per million tokens (MTok) by model family prefix.
  // Source: developers.openai.com/api/docs/pricing, Standard tier (checked 2026-11-01)
  const pricing: Record<string, OpenAIPricing> = {
    // GPT-6 models
    "gpt-6.1-sol": {
      input: 2,
      cachedInput: 0.1,
      output: 10,
      longContext: { input: 4, cachedInput: 0.2, output: 15 },
    },
    "gpt-6.1-terra": {
      input: 1,
      cachedInput: 0.05,
      output: 5,
      longContext: { input: 2, cachedInput: 0.1, output: 7.5 },
    },
    "gpt-6-sol": {
      input: 2,
      cachedInput: 0.2,
      output: 10,
      longContext: { input: 4, cachedInput: 0.4, output: 15 },
    },
    "gpt-6-luna": {
      input: 0.1,
      cachedInput: 0.01,
      output: 0.5,
      longContext: { input: 0.2, cachedInput: 0.02, output: 0.75 },
    },
    "gpt-6-astra": {
      input: 10,
      cachedInput: 1,
      output: 50,
      longContext: { input: 20, cachedInput: 2, output: 75 },
    },

    // GPT-5 models (most specific first)
    "gpt-5.6-sol": {
      input: 4,
      cachedInput: 0.4,
      output: 20,
      longContext: { input: 8, cachedInput: 0.8, output: 30 },
    },
    "gpt-5.6-terra": {
      input: 2,
      cachedInput: 0.2,
      output: 12,
      longContext: { input: 4, cachedInput: 0.4, output: 18 },
    },
    "gpt-5.6-luna": {
      input: 0.2,
      cachedInput: 0.02,
      output: 1.2,
      longContext: { input: 0.4, cachedInput: 0.04, output: 1.8 },
    },
    "gpt-5.5-pro": {
      input: 30,
      output: 180,
      longContext: { input: 60, output: 270 },
    },
    "gpt-5.5": {
      input: 5,
      cachedInput: 0.5,
      output: 30,
      longContext: { input: 10, cachedInput: 1, output: 45 },
    },
    "gpt-5.4-pro": {
      input: 30,
      output: 180,
      longContext: { input: 60, output: 270 },
    },
    "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
    "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
    "gpt-5.4": {
      input: 2.5,
      cachedInput: 0.25,
      output: 15,
      longContext: { input: 5, cachedInput: 0.5, output: 22.5 },
    },
    "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
    "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14 },
    "gpt-5.1": { input: 1.25, cachedInput: 0.125, output: 10 },
    "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
    "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.4 },
    "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },

    // o-series
    o3: { input: 2, cachedInput: 0.5, output: 8 },

    // GPT-4o models (most specific first)
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "gpt-4o": { input: 2.5, output: 10 },

    // GPT-4 Turbo models
    "gpt-4-turbo": { input: 10, output: 30 },

    // GPT-3.5 Turbo models (most specific first)
    "gpt-3.5-turbo-0125": { input: 0.5, output: 1.5 },
    "gpt-3.5-turbo-1106": { input: 1, output: 2 },
    "gpt-3.5-turbo": { input: 1.5, output: 2 },

    // Base GPT-4 (fallback for other gpt-4 variants)
    "gpt-4": { input: 30, output: 60 },
  };

  // Sort keys by length (longest first) to match most specific patterns first
  const sortedKeys = Object.keys(pricing).sort((a, b) => b.length - a.length);

  let basePricing: OpenAIPricing | null = null;
  for (const prefix of sortedKeys) {
    if (normalizedModel.startsWith(prefix)) {
      basePricing = pricing[prefix];
      break;
    }
  }

  if (!basePricing) {
    return null; // Unknown model
  }

  const modelPricing =
    basePricing.longContext && usage.promptTokens > OPENAI_LONG_CONTEXT_TOKENS
      ? basePricing.longContext
      : basePricing;

  // OpenAI's prompt token count includes cached tokens, which are billed at the cached rate
  const cachedTokens =
    modelPricing.cachedInput === undefined
      ? 0
      : Math.min(
          usage.promptTokensDetails?.cachedTokens ?? 0,
          usage.promptTokens,
        );
  const uncachedTokens = usage.promptTokens - cachedTokens;

  // Calculate costs
  const inputCost = (uncachedTokens / 1_000_000) * modelPricing.input;
  const cachedCost =
    (cachedTokens / 1_000_000) * (modelPricing.cachedInput ?? 0);
  const outputCost = (usage.completionTokens / 1_000_000) * modelPricing.output;

  // Build breakdown components
  const breakdownParts: string[] = [];

  if (uncachedTokens > 0) {
    breakdownParts.push(
      `Input: ${uncachedTokens.toLocaleString()} tokens × $${modelPricing.input}/MTok = $${inputCost.toFixed(6)}`,
    );
  }

  if (cachedTokens > 0) {
    breakdownParts.push(
      `Cached Input: ${cachedTokens.toLocaleString()} tokens × $${modelPricing.cachedInput}/MTok = $${cachedCost.toFixed(6)}`,
    );
  }

  if (usage.completionTokens > 0) {
    breakdownParts.push(
      `Output: ${usage.completionTokens.toLocaleString()} tokens × $${modelPricing.output}/MTok = $${outputCost.toFixed(6)}`,
    );
  }

  const totalCost = inputCost + cachedCost + outputCost;

  // Build final breakdown string
  let breakdown = `Model: ${model}\n`;
  breakdown += breakdownParts.join("\n");
  if (breakdownParts.length > 1) {
    breakdown += `\nTotal: $${totalCost.toFixed(6)}`;
  }

  return {
    cost: totalCost,
    breakdown,
  };
}

export function calculateRequestCost(
  provider: string,
  model: string,
  usage: Usage,
): CostBreakdown | null {
  switch (provider.toLowerCase()) {
    case "anthropic":
      return calculateAnthropicCost(model, usage);
    case "openai":
      return calculateOpenAICost(model, usage);
    default:
      return null;
  }
}
