import {
  findCatalogCost,
  findGeneralCost,
  type CatalogCost,
} from "@nextcli/llm-info";

import type { Usage } from "../../..";

import { ONEPROVIDER_RATES } from "./oneproviderRates";

/** Prices in US dollars per million tokens */
export interface HostRates {
  input: number;
  output: number;
  /** Price of cached prompt tokens. When absent, they cost the input price. */
  cachedInput?: number;
  /** Price of prompt tokens written to the cache. When absent, the input price. */
  cacheWrite?: number;
  /** Higher prices once the prompt is longer than `above` tokens */
  tiers?: Array<Omit<HostRates, "tiers"> & { above: number }>;
}

// Suffixes a host adds to a listed model without changing its price: dated
// snapshots and the thinking, preview and effort variants. Anything else (for
// example "-pro" after "gpt-5.5") is a different model and must not match.
const VARIANT_SUFFIX =
  /^(?:-(?:\d{4}(?:-\d{2}){0,2}|\d{6,8}|thinking|preview|low|high|tiered))+$/;

function sortedByLength(keys: string[]): string[] {
  return [...keys].sort((a, b) => b.length - a.length);
}

function findRates(
  table: Record<string, HostRates>,
  keys: string[],
  model: string,
): HostRates | undefined {
  if (table[model]) {
    return table[model];
  }
  const key = keys.find(
    (candidate) =>
      model.startsWith(candidate) &&
      VARIANT_SUFFIX.test(model.slice(candidate.length)),
  );
  return key ? table[key] : undefined;
}

const ONEPROVIDER_KEYS = sortedByLength(Object.keys(ONEPROVIDER_RATES));

/** Rates for a model called through oneprovider.dev */
export function findOneproviderRates(model: string): HostRates | undefined {
  const name = model.toLowerCase().split("/").pop() ?? "";
  return findRates(ONEPROVIDER_RATES, ONEPROVIDER_KEYS, name);
}

function ratesFromCatalog(
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

/**
 * A provider's own rates for a model, from the models.dev catalog snapshot
 * in @nextcli/llm-info (npm run sync-models). `catalogProvider` is the
 * catalog's provider id, such as "openrouter" or "deepseek".
 */
export function findCatalogRates(
  catalogProvider: string | undefined,
  model: string,
): HostRates | undefined {
  return ratesFromCatalog(findCatalogCost(catalogProvider, model));
}

/** Rates for an OpenRouter model id, such as "deepseek/deepseek-v4-pro" */
export function findOpenRouterRates(model: string): HostRates | undefined {
  return findCatalogRates("openrouter", model);
}

/**
 * General rates for a model on a host without its own prices (a custom
 * gateway, a local bridge): OpenRouter's price for a model of the same name,
 * the highest when several vendors list it, never a free variant.
 */
export function findGeneralRates(model: string): HostRates | undefined {
  return ratesFromCatalog(findGeneralCost(model));
}

export function hostOf(apiBase: string | undefined): string | undefined {
  if (!apiBase) {
    return undefined;
  }
  try {
    return new URL(apiBase).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isHostOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** The rates for the prompt's length: the highest tier it passes, if any */
function ratesForPrompt(rates: HostRates, promptTokens: number): HostRates {
  const tier = [...(rates.tiers ?? [])]
    .sort((a, b) => b.above - a.above)
    .find((candidate) => promptTokens > candidate.above);
  return tier ? { ...rates, ...tier } : rates;
}

function describe(tokens: number, label: string, price: number): string {
  return `${label}: ${tokens.toLocaleString()} tokens × $${price}/MTok = $${((tokens / 1_000_000) * price).toFixed(6)}`;
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
  const cachedTokens =
    rates.cachedInput === undefined
      ? 0
      : Math.min(
          usage.promptTokensDetails?.cachedTokens ?? 0,
          usage.promptTokens,
        );
  const cacheWriteTokens =
    rates.cacheWrite === undefined
      ? 0
      : Math.min(
          usage.promptTokensDetails?.cacheWriteTokens ?? 0,
          usage.promptTokens - cachedTokens,
        );
  const uncachedTokens = usage.promptTokens - cachedTokens - cacheWriteTokens;
  const inputCost = (uncachedTokens / 1_000_000) * rates.input;
  const cachedCost = (cachedTokens / 1_000_000) * (rates.cachedInput ?? 0);
  const cacheWriteCost =
    (cacheWriteTokens / 1_000_000) * (rates.cacheWrite ?? 0);
  const outputCost = (usage.completionTokens / 1_000_000) * rates.output;

  const parts: string[] = [];
  if (uncachedTokens > 0) {
    parts.push(describe(uncachedTokens, "Input", rates.input));
  }
  if (cachedTokens > 0) {
    parts.push(describe(cachedTokens, "Cached Input", rates.cachedInput ?? 0));
  }
  if (cacheWriteTokens > 0) {
    parts.push(
      describe(cacheWriteTokens, "Cache Write", rates.cacheWrite ?? 0),
    );
  }
  if (usage.completionTokens > 0) {
    parts.push(describe(usage.completionTokens, "Output", rates.output));
  }
  const cost = inputCost + cachedCost + cacheWriteCost + outputCost;
  let breakdown = `Model: ${model}\n${parts.join("\n")}`;
  if (parts.length > 1) {
    breakdown += `\nTotal: $${cost.toFixed(6)}`;
  }
  return { cost, breakdown };
}
