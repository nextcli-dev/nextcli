import {
  CATALOG_SYNCED_AT,
  catalogProviderFor,
  findCatalogCost,
  findCatalogFastCost,
  findGeneralCost,
  hasUnknownZeroPrice,
  hostOf,
  isHostOrSubdomain,
  resolveCatalog,
  vendorCatalogProvider,
} from "@nextcli/llm-info";

import { Usage } from "../..";

import {
  findOneproviderRates,
  priceWithHostRates,
  ratesFromCatalog,
} from "./rates/hostRates";
import type { HostRates } from "./rates/hostRates";

/**
 * exact: the price the host bills: OneProvider's own table, or a maker's
 * list price (from the models.dev catalog) on the maker's own API.
 * catalog: the provider's own price, from the models.dev catalog snapshot.
 * estimated: a price for a host that may charge differently: a maker's list
 * price on another host, OpenRouter's price for a model of the same name, a
 * routed OpenRouter variant, or the standard price of a fast request whose
 * fast price isn't known.
 */
export type PriceSource = "exact" | "catalog" | "estimated";

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

/** The makers' own APIs, where their list prices are what is billed */
const MAKER_HOSTS: Record<string, string> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
};

/**
 * OpenRouter's routing variants (fastest, cheapest, web search, tool-call
 * accuracy) of a listed model: priced like the model, but not exactly
 */
const OPENROUTER_ROUTING = /:(?:nitro|floor|online|exacto)$/;

interface PriceRoute {
  normalizedProvider: string;
  host: string | undefined;
  /** A host on this machine: a local server or a bridge */
  thisMachine: boolean;
  oneProvider: boolean;
  /** The catalog the model's prices come from, if any */
  catalogProvider: string | undefined;
  /** The id to price: an OpenRouter routing variant's base model */
  model: string;
  /** How a catalog price on this route is labelled */
  source: PriceSource;
}

/**
 * Where a request's prices come from. The host kind (this machine,
 * OneProvider, an official API host such as api.groq.com or openrouter.ai)
 * is resolveCatalog's answer in @nextcli/llm-info, shared with the model
 * menus. A configured provider brings its own catalog for prices even on a
 * custom host, where a maker's list price becomes an estimate.
 */
function priceRoute(
  provider: string,
  model: string,
  apiBase: string | undefined,
): PriceRoute {
  const normalizedProvider = provider.toLowerCase();
  const host = hostOf(apiBase);
  const route = resolveCatalog({ provider, model, apiBase });
  const oneProvider = route.host === "oneprovider";
  const catalogProvider = oneProvider
    ? undefined
    : (route.hostCatalog ?? catalogProviderFor(provider));
  const makerHost = MAKER_HOSTS[catalogProvider ?? ""];
  const offMakerHost =
    !!makerHost && !!host && !isHostOrSubdomain(host, makerHost);
  const routed =
    catalogProvider === "openrouter" && OPENROUTER_ROUTING.test(model);
  return {
    normalizedProvider,
    host,
    thisMachine: route.host === "this-machine",
    oneProvider,
    catalogProvider,
    model: routed ? model.replace(OPENROUTER_ROUTING, "") : model,
    source:
      offMakerHost || routed ? "estimated" : makerHost ? "exact" : "catalog",
  };
}

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
  const route = priceRoute(provider, model, apiBase);
  if (!hasUnknownZeroPrice(route.catalogProvider, route.model)) {
    return undefined;
  }
  return (
    `the models.dev catalog lists ${model} (${route.catalogProvider}) at $0, ` +
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
  route: PriceRoute,
  model: string,
  usage: Usage,
  options: RequestCostOptions,
): CostBreakdown | null {
  // A bridge's provider is often just the protocol it speaks (openai), so
  // the model's own vendor comes first
  const vendor =
    vendorCatalogProvider(model) ??
    (MAKER_HOSTS[route.normalizedProvider]
      ? route.normalizedProvider
      : undefined);
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
 * Prices one request:
 *
 * 1. A host on this machine (localhost, 127.x, host.docker.internal): a
 *    local model server has no price; any other provider is a bridge, priced
 *    at a floor (bridgeFloor).
 * 2. OneProvider (provider or host): its own price table, exact.
 * 3. The catalog of the route: an official API host's (api.groq.com,
 *    openrouter.ai) under any provider name, else the configured provider's
 *    own. A maker's list price (Anthropic, OpenAI) is exact on the maker's
 *    API and estimated on any other host; other providers' prices are
 *    catalog. OpenRouter's routing variants (:nitro, :floor, ...) are
 *    estimated.
 * 4. With `estimateUnknown`, the general price (OpenRouter's for the name):
 *    estimated. Not for local model servers on their local default.
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
  const route = priceRoute(provider, model, options.apiBase);
  const localServer = LOCAL_MODEL_SERVERS.has(route.normalizedProvider);
  if (route.thisMachine) {
    return localServer ? null : bridgeFloor(route, model, usage, options);
  }

  if (route.oneProvider) {
    const rates = findOneproviderRates(model);
    if (rates) {
      const { cost, breakdown } = priceWithHostRates(model, rates, usage);
      return { cost, breakdown, priced: options.fast ? "estimated" : "exact" };
    }
  } else {
    const fastRates = options.fast
      ? ratesFromCatalog(
          findCatalogFastCost(route.catalogProvider, route.model),
        )
      : undefined;
    if (fastRates) {
      return fromCatalog(model, fastRates, usage, route.source, "fast mode");
    }
    const rates = ratesFromCatalog(
      findCatalogCost(route.catalogProvider, route.model),
    );
    if (rates) {
      // A fast request without a known fast price: the standard price
      return fromCatalog(
        model,
        rates,
        usage,
        options.fast ? "estimated" : route.source,
      );
    }
  }

  if (localServer && !route.host) {
    return null;
  }
  return generalEstimate(route.model, usage, options);
}
