import type { Usage } from "../../..";

import { ONEPROVIDER_RATES } from "./oneproviderRates";
import { OPENROUTER_RATES } from "./openrouterRates";

/** Prices in US dollars per million tokens */
export interface HostRates {
  input: number;
  output: number;
  /** Price of cached prompt tokens. When absent, they cost the input price. */
  cachedInput?: number;
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

/** Rates for an OpenRouter model id, such as "deepseek/deepseek-v4-pro" */
export function findOpenRouterRates(model: string): HostRates | undefined {
  return OPENROUTER_RATES[model.toLowerCase()];
}

function normalizeModelName(model: string): string {
  return (model.toLowerCase().split("/").pop() ?? "").replace(/\./g, "-");
}

let openRouterByName: Record<string, HostRates> | undefined;
let openRouterNameKeys: string[] = [];

/**
 * Estimates rates for a model on a host without its own price table, from
 * the OpenRouter price of the model with the same name. Names are compared
 * without the vendor prefix and with "." as "-", so "claude-opus-5-5" finds
 * "anthropic/claude-opus-5.5". When several vendors list the same name, the
 * highest input price wins, so the estimate errs high.
 */
export function estimateRatesFromOpenRouter(
  model: string,
): HostRates | undefined {
  if (!openRouterByName) {
    openRouterByName = {};
    for (const [id, rates] of Object.entries(OPENROUTER_RATES)) {
      if (id.includes(":")) {
        continue; // :free, :batch and similar are priced differently
      }
      const name = normalizeModelName(id);
      const current = openRouterByName[name];
      if (!current || rates.input > current.input) {
        openRouterByName[name] = rates;
      }
    }
    openRouterNameKeys = sortedByLength(Object.keys(openRouterByName));
  }
  return findRates(
    openRouterByName,
    openRouterNameKeys,
    normalizeModelName(model),
  );
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

/** Hosts on the user's machine or network, where calls cost nothing */
export function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/**
 * Prices a request with OpenAI-style usage, where the prompt token count
 * includes cached tokens.
 */
export function priceWithHostRates(
  model: string,
  rates: HostRates,
  usage: Usage,
): { cost: number; breakdown: string } {
  const cachedTokens =
    rates.cachedInput === undefined
      ? 0
      : Math.min(
          usage.promptTokensDetails?.cachedTokens ?? 0,
          usage.promptTokens,
        );
  const uncachedTokens = usage.promptTokens - cachedTokens;
  const inputCost = (uncachedTokens / 1_000_000) * rates.input;
  const cachedCost = (cachedTokens / 1_000_000) * (rates.cachedInput ?? 0);
  const outputCost = (usage.completionTokens / 1_000_000) * rates.output;

  const parts: string[] = [];
  if (uncachedTokens > 0) {
    parts.push(
      `Input: ${uncachedTokens.toLocaleString()} tokens × $${rates.input}/MTok = $${inputCost.toFixed(6)}`,
    );
  }
  if (cachedTokens > 0) {
    parts.push(
      `Cached Input: ${cachedTokens.toLocaleString()} tokens × $${rates.cachedInput}/MTok = $${cachedCost.toFixed(6)}`,
    );
  }
  if (usage.completionTokens > 0) {
    parts.push(
      `Output: ${usage.completionTokens.toLocaleString()} tokens × $${rates.output}/MTok = $${outputCost.toFixed(6)}`,
    );
  }
  const cost = inputCost + cachedCost + outputCost;
  let breakdown = `Model: ${model}\n${parts.join("\n")}`;
  if (parts.length > 1) {
    breakdown += `\nTotal: $${cost.toFixed(6)}`;
  }
  return { cost, breakdown };
}
