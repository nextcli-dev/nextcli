import {
  CATALOG_SYNCED_AT,
  findCatalogCost,
  findCatalogFastCost,
  findGeneralCost,
  hasUnknownZeroPrice,
  hostOf,
  isMakerCatalog,
  resolveCatalog,
  vendorCatalogProvider,
  type PriceSource,
} from "@nextcli/llm-info";

import { ModelPricing, Usage } from "../..";

import {
  findOneproviderRates,
  priceWithHostRates,
  ratesFromCatalog,
} from "./rates/hostRates";
import type { HostRates } from "./rates/hostRates";

export type { PriceSource };

export interface CostBreakdown {
  cost: number;
  breakdown: string;
  priced?: PriceSource;
  /** The catalog snapshot's date, when the price came from it */
  catalogDate?: string;
}

export interface RequestCostOptions {
  /** The model's API base URL. Hosts with their own prices are matched on it. */
  apiBase?: string;
  /**
   * Price models nothing else prices with the general price (OpenRouter's,
   * for a model of the same name) instead of returning null. Never applied
   * to local model servers.
   */
  estimateUnknown?: boolean;
  /** The request was sent in the model's fast or priority mode */
  fast?: boolean;
  /** The model's configured prices, which win over every other price */
  pricing?: ModelPricing;
}

/**
 * Servers that run models on the user's own hardware. On this machine, or
 * without an apiBase (their local default), calls to them have no price.
 */
const LOCAL_MODEL_SERVERS = new Set([
  "docker",
  "huggingface-tei",
  "huggingface-tgi",
  "lemonade",
  "llama.cpp",
  "llamacpp",
  "llamafile",
  "llamastack",
  "lmstudio",
  "msty",
  "ollama",
  "text-gen-webui",
  "vllm",
]);

/**
 * A warning for a model the catalog lists at $0, which means its price is
 * unknown: the model is priced like an unlisted one instead of as free, so
 * cost limits still count it. Undefined for any other model.
 */
export function unknownZeroPriceWarning(
  provider: string,
  model: string,
  apiBase?: string,
): string | undefined {
  const { price } = resolveCatalog({ provider, model, apiBase });
  if (!hasUnknownZeroPrice(price.catalogProvider, price.model)) {
    return undefined;
  }
  return (
    `the models.dev catalog lists ${model} (${price.catalogProvider}) at $0, ` +
    "which means its price is unknown, not that it is free. It is priced " +
    "as an estimate, or at the CLI's flat fallback rate when nothing else " +
    "knows it, so --max-cost still counts it."
  );
}

function fromCatalog(
  model: string,
  rates: HostRates,
  usage: Usage,
  priced: PriceSource,
  note?: string,
): CostBreakdown {
  const { cost, breakdown } = priceWithHostRates(model, rates, usage);
  return {
    cost,
    breakdown: note ? `${breakdown}\n(${note})` : breakdown,
    priced,
    catalogDate: CATALOG_SYNCED_AT,
  };
}

/** OpenRouter's price for a model of the same name, with `estimateUnknown` */
function generalEstimate(
  model: string,
  usage: Usage,
  options: RequestCostOptions,
): CostBreakdown | null {
  if (!options.estimateUnknown) {
    return null;
  }
  const rates = ratesFromCatalog(findGeneralCost(model));
  return rates
    ? fromCatalog(
        model,
        rates,
        usage,
        "estimated",
        "estimated from OpenRouter prices",
      )
    : null;
}

/**
 * A bridge on this machine: NextCLI can't see where it forwards, so a model
 * it knows by name is priced at its vendor's list price as a floor (the
 * vendor from the name, else the anthropic or openai provider), or else at
 * OpenRouter's price for the name. Both are estimates.
 */
function bridgeFloor(
  provider: string,
  model: string,
  usage: Usage,
  options: RequestCostOptions,
): CostBreakdown | null {
  // A bridge's provider is often just the protocol it speaks (openai), so
  // the model's own vendor comes first
  const vendor =
    vendorCatalogProvider(model) ??
    (isMakerCatalog(provider) ? provider : undefined);
  const vendorRates = ratesFromCatalog(findCatalogCost(vendor, model));
  if (vendorRates) {
    return fromCatalog(
      model,
      vendorRates,
      usage,
      "estimated",
      `estimated from ${vendor}'s list price; the bridge's upstream isn't known`,
    );
  }
  return generalEstimate(model, usage, options);
}

/**
 * Prices one request. The model's configured `pricing` wins, exact, fast
 * mode included. Otherwise, by resolveCatalog's route in @nextcli/llm-info:
 *
 * 1. A local model server on this machine (localhost, 127.x,
 *    host.docker.internal) or on its local default (no API base): no price.
 * 2. Any other provider on this machine is a bridge, priced at a floor
 *    (bridgeFloor).
 * 3. OneProvider (provider or host): its own price table, exact.
 * 4. The catalog of the route: an official API host's (api.groq.com,
 *    openrouter.ai) under any provider name, else the configured provider's
 *    own. A maker's list price (Anthropic, OpenAI) is exact on the maker's
 *    API and estimated on any other host; other providers' prices are
 *    catalog. OpenRouter's routing variants (:nitro, :floor, ...) are
 *    estimated.
 * 5. With `estimateUnknown`, the general price (OpenRouter's for the name):
 *    estimated.
 *
 * A catalog price of $0 means the price is unknown (unknownZeroPriceWarning)
 * and counts as no price, except OpenRouter's `:free` ids. A fast request
 * uses the catalog's fast price; without one, the standard price is used and
 * marked estimated.
 */
export function calculateRequestCost(
  provider: string,
  model: string,
  usage: Usage,
  options: RequestCostOptions = {},
): CostBreakdown | null {
  if (options.pricing) {
    const { cost, breakdown } = priceWithHostRates(
      model,
      ratesFromCatalog(options.pricing)!,
      usage,
    );
    return { cost, breakdown, priced: "exact" };
  }
  const route = resolveCatalog({ provider, model, apiBase: options.apiBase });
  const normalizedProvider = provider.toLowerCase();
  if (
    LOCAL_MODEL_SERVERS.has(normalizedProvider) &&
    (route.host === "this-machine" || !hostOf(options.apiBase))
  ) {
    return null;
  }
  if (route.host === "this-machine") {
    return bridgeFloor(normalizedProvider, model, usage, options);
  }

  if (route.host === "oneprovider") {
    const rates = findOneproviderRates(model);
    if (!rates) {
      return generalEstimate(model, usage, options);
    }
    const { cost, breakdown } = priceWithHostRates(model, rates, usage);
    return { cost, breakdown, priced: options.fast ? "estimated" : "exact" };
  }

  const { price } = route;
  const fastRates = options.fast
    ? ratesFromCatalog(findCatalogFastCost(price.catalogProvider, price.model))
    : undefined;
  if (fastRates) {
    return fromCatalog(model, fastRates, usage, price.source, "fast mode");
  }
  const rates = ratesFromCatalog(
    findCatalogCost(price.catalogProvider, price.model),
  );
  if (rates) {
    // A fast request without a known fast price: the standard price
    return fromCatalog(
      model,
      rates,
      usage,
      options.fast ? "estimated" : price.source,
    );
  }
  return generalEstimate(price.model, usage, options);
}
