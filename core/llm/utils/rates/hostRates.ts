import {
  longestListedBase,
  variantSuffix,
  type CatalogCost,
} from "@nextcli/llm-info";

import type { Usage } from "../../..";

import { ONEPROVIDER_RATES } from "./oneproviderRates";

/** Prices in US dollars per million tokens */
export interface HostRates {
  input: number;
  output: number;
  /** Price of cached prompt tokens. When absent, they are billed as input. */
  cachedInput?: number;
  /**
   * Price of prompt tokens written to the cache. When absent, they are
   * billed as input.
   */
  cacheWrite?: number;
  /** Higher prices once the prompt is longer than `above` tokens */
  tiers?: Array<Omit<HostRates, "tiers"> & { above: number }>;
}

// Suffixes a host adds to a listed model without changing its price: dated
// snapshots, the thinking and preview variants, and OneProvider's effort
// suffixes. Anything else (for example "-pro" after "gpt-5.5") is a
// different model and must not match.
const VARIANT_SUFFIX = variantSuffix(["low", "high", "tiered"]);

/** Rates for a model called through oneprovider.dev */
export function findOneproviderRates(model: string): HostRates | undefined {
  const name = model.toLowerCase().split("/").pop() ?? "";
  const key = ONEPROVIDER_RATES[name]
    ? name
    : longestListedBase(name, Object.keys(ONEPROVIDER_RATES), VARIANT_SUFFIX);
  return key ? ONEPROVIDER_RATES[key] : undefined;
}

/**
 * Rates from a models.dev catalog price in @nextcli/llm-info (npm run
 * sync-models): a provider's own price, its fast price or the general price
 */
export function ratesFromCatalog(
  cost: CatalogCost | undefined,
): HostRates | undefined {
  if (!cost) {
    return undefined;
  }
  return {
    input: cost.input,
    output: cost.output,
    ...(cost.cacheRead !== undefined && { cachedInput: cost.cacheRead }),
    ...(cost.cacheWrite !== undefined && { cacheWrite: cost.cacheWrite }),
    ...(cost.tiers && {
      tiers: cost.tiers.map((tier) => ({
        above: tier.above,
        input: tier.input,
        output: tier.output,
        ...(tier.cacheRead !== undefined && { cachedInput: tier.cacheRead }),
        ...(tier.cacheWrite !== undefined && { cacheWrite: tier.cacheWrite }),
      })),
    }),
  };
}

/** The rates for the prompt's length: the highest tier it passes, if any */
function ratesForPrompt(rates: HostRates, promptTokens: number): HostRates {
  const tier = [...(rates.tiers ?? [])]
    .sort((a, b) => b.above - a.above)
    .find((candidate) => promptTokens > candidate.above);
  return tier ? { ...rates, ...tier } : rates;
}

/**
 * The prompt tokens billed at a cache rate, at most `room`: none when the
 * host lists no rate for them, so they stay input tokens
 */
function atCacheRate(
  tokens: number | undefined,
  rate: number | undefined,
  room: number,
): { tokens: number; rate: number } {
  return rate === undefined
    ? { tokens: 0, rate: 0 }
    : { tokens: Math.min(tokens ?? 0, room), rate };
}

/**
 * Prices a request with OpenAI-style usage, where the prompt token count
 * includes cached tokens: cache reads and writes are parts of it.
 */
export function priceWithHostRates(
  model: string,
  hostRates: HostRates,
  usage: Usage,
): { cost: number; breakdown: string } {
  const rates = ratesForPrompt(hostRates, usage.promptTokens);
  const details = usage.promptTokensDetails;
  const cached = atCacheRate(
    details?.cachedTokens,
    rates.cachedInput,
    usage.promptTokens,
  );
  const cacheWrite = atCacheRate(
    details?.cacheWriteTokens,
    rates.cacheWrite,
    usage.promptTokens - cached.tokens,
  );
  const uncachedTokens = usage.promptTokens - cached.tokens - cacheWrite.tokens;
  const parts = (
    [
      ["Input", uncachedTokens, rates.input],
      ["Cached Input", cached.tokens, cached.rate],
      ["Cache Write", cacheWrite.tokens, cacheWrite.rate],
      ["Output", usage.completionTokens, rates.output],
    ] as const
  ).filter(([, tokens]) => tokens > 0);
  const cost = parts.reduce(
    (sum, [, tokens, rate]) => sum + (tokens / 1_000_000) * rate,
    0,
  );
  const lines = parts.map(
    ([label, tokens, rate]) =>
      `${label}: ${tokens.toLocaleString()} tokens × $${rate}/MTok = $${((tokens / 1_000_000) * rate).toFixed(6)}`,
  );
  let breakdown = `Model: ${model}\n${lines.join("\n")}`;
  if (lines.length > 1) {
    breakdown += `\nTotal: $${cost.toFixed(6)}`;
  }
  return { cost, breakdown };
}
