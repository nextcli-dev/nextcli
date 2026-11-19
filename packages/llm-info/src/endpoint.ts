/**
 * Which models.dev catalog describes a model on a given endpoint, and which
 * one prices it. The model menus (openai-adapters' modelProfile), the
 * default limits (findLlmInfo) and the prices (core's calculateRequestCost)
 * all ask resolveCatalog, so every host is special-cased here only.
 */

import {
  CATALOG_PROVIDERS,
  catalogProviderFor,
  findCatalogModel,
  type CatalogMatch,
} from "./catalog.js";

/** The lowercase host name of an API base, if it parses */
export function hostOf(apiBase: string | undefined): string | undefined {
  if (!apiBase) return undefined;
  try {
    return new URL(apiBase).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isHostOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Hosts on the user's own machine, including the names containers use to
 * reach it. Private-network addresses (10.x, 172.16-31.x, 192.168.x, .local
 * names) are other machines and are treated like any other host.
 */
export function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "host.docker.internal" ||
    host === "host.containers.internal" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    // ::ffff:127.0.0.1, as URL writes it
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host) ||
    /^127\./.test(host)
  );
}

/**
 * Official API hosts whose catalog applies whichever provider the config
 * names: Groq or OpenRouter set up as an OpenAI-compatible endpoint is still
 * Groq or OpenRouter. Subdomains match too, and the most specific domain
 * wins.
 *
 * Alibaba's hosts take its pay-as-you-go catalogs: the international one
 * (Qwen Cloud, DashScope international) and China's. Its token and coding
 * plans use them too, priced as estimates (PLAN_HOSTS): models.dev lists
 * plan models at $0, and a list price overstates a plan's cost rather than
 * hiding it.
 */
export const CATALOG_HOSTS: Readonly<Record<string, string>> = {
  "api.groq.com": "groq",
  "coding-intl.dashscope.aliyuncs.com": "alibaba",
  "dashscope-intl.aliyuncs.com": "alibaba",
  "dashscope.aliyuncs.com": "alibaba-cn",
  "openrouter.ai": "openrouter",
  "qwencloudapi.com": "alibaba",
};

/** The models.dev provider of an API base's host, if it is an official one */
export function catalogProviderForApiBase(
  apiBase: string | undefined,
): string | undefined {
  const host = hostOf(apiBase);
  if (!host) return undefined;
  let best: string | undefined;
  for (const domain of Object.keys(CATALOG_HOSTS)) {
    if (
      isHostOrSubdomain(host, domain) &&
      (!best || domain.length > best.length)
    ) {
      best = domain;
    }
  }
  return best && CATALOG_HOSTS[best];
}

/**
 * Subscription plans billed by the plan, not per token: Alibaba's token
 * plans (token-plan.*) and coding plans (coding.dashscope.aliyuncs.com and
 * coding-intl.dashscope.aliyuncs.com). Their catalog prices are estimates.
 */
const PLAN_HOSTS: readonly RegExp[] = [
  /^token-plan\./,
  /^coding(?:-intl)?\.dashscope\.aliyuncs\.com$/,
];

function isPlanHost(host: string | undefined): boolean {
  return !!host && PLAN_HOSTS.some((pattern) => pattern.test(host));
}

/** Whether an API base is OneProvider's, whichever provider id the config uses */
export function isOneProviderBase(apiBase: string | undefined): boolean {
  const host = hostOf(apiBase);
  return !!host && isHostOrSubdomain(host, "oneprovider.dev");
}

/** The makers' own APIs, where their list prices are what is billed */
const MAKER_HOSTS: Readonly<Record<string, string>> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
};

/** Whether a models.dev provider is a maker selling on its own API */
export function isMakerCatalog(catalogProvider: string | undefined): boolean {
  return !!catalogProvider && Object.hasOwn(MAKER_HOSTS, catalogProvider);
}

/**
 * OpenRouter's routing variants (fastest, cheapest, web search, tool-call
 * accuracy) of a listed model: priced like the model, but not exactly
 */
const OPENROUTER_ROUTING = /:(?:nitro|floor|online|exacto)$/;

const OPENAI_API_BASE = "https://api.openai.com/v1/";

function isOfficialOpenAI(apiBase: string | undefined): boolean {
  return !apiBase || apiBase.replace(/\/?$/, "/") === OPENAI_API_BASE;
}

/** Strips a vendor prefix such as `anthropic/` (OpenRouter model ids) */
export function baseModelName(model: string): string {
  const slash = model.lastIndexOf("/");
  return (slash === -1 ? model : model.slice(slash + 1)).toLowerCase();
}

export function isClaude(model: string): boolean {
  return baseModelName(model).includes("claude");
}

/** The models.dev provider of a model's vendor, from the model's name */
const VENDORS: Array<[RegExp, string]> = [
  [/^claude/, "anthropic"],
  [/^(gpt|o\d|chatgpt)/, "openai"],
  [/^gemini/, "google"],
  [/^grok/, "xai"],
  [/^deepseek/, "deepseek"],
  [/^kimi/, "moonshotai"],
  [/^glm/, "zai"],
  [/^minimax/, "minimax"],
  [/^(mistral|codestral|devstral|magistral|ministral)/, "mistral"],
];

/** OpenRouter's vendor slugs that differ from the models.dev provider id */
const OPENROUTER_VENDORS: Record<string, string> = {
  google: "google",
  "x-ai": "xai",
  "z-ai": "zai",
  mistralai: "mistral",
};

/**
 * The models.dev provider of the model's vendor: from an OpenRouter-style
 * `vendor/` prefix, else from the model's name
 */
export function vendorCatalogProvider(model: string): string | undefined {
  const slash = model.indexOf("/");
  if (slash !== -1) {
    const vendor = model.slice(0, slash).toLowerCase();
    const mapped = OPENROUTER_VENDORS[vendor] ?? vendor;
    if (Object.values(CATALOG_PROVIDERS).includes(mapped)) {
      return mapped;
    }
  }
  const name = baseModelName(model);
  return VENDORS.find(([pattern]) => pattern.test(name))?.[1];
}

/**
 * Bedrock ids carry a region and a version around the vendor's id:
 * us.anthropic.claude-opus-5-5-v1:0
 */
function claudeNameOnBedrock(model: string): string {
  const match = baseModelName(model).match(
    /claude-[a-z0-9.-]+?(?=-v\d+(:\d+)?$|$)/,
  );
  return match?.[0] ?? model;
}

export function withoutThinkingSuffix(model: string): string {
  return model.replace(/-thinking$/i, "");
}

/** The model's entry in its vendor's own catalog */
export function vendorCatalogMatch(model: string): CatalogMatch | undefined {
  const name = withoutThinkingSuffix(model);
  return findCatalogModel(vendorCatalogProvider(name), baseModelName(name));
}

export interface ModelEndpoint {
  provider: string;
  model: string;
  apiBase?: string;
}

/**
 * How a price is labelled. exact: what the host bills (OneProvider's own
 * table, or a maker's list price on the maker's own API). catalog: the
 * provider's own price, from the models.dev snapshot. estimated: a price for
 * a host that may charge differently (a maker's list price on another host,
 * OpenRouter's price for a model of the same name, a routed OpenRouter
 * variant, a list price on a subscription plan's host, or the standard price
 * of a fast request whose fast price isn't known).
 */
export type PriceSource = "exact" | "catalog" | "estimated";

export interface CatalogPriceRoute {
  /**
   * The catalog with the model's prices: the official host's, else the
   * configured provider's own, also on a custom host, where a maker's list
   * price becomes an estimate. None for OneProvider, which has its own
   * price table.
   */
  catalogProvider?: string;
  /** The id to price: an OpenRouter routing variant's base model */
  model: string;
  /** How a catalog price on this route is labelled */
  source: PriceSource;
}

export interface CatalogRoute {
  /**
   * What the API base is: this machine (a local server or a bridge),
   * OneProvider, an official API host with its own catalog, or anything
   * else (no API base included)
   */
  host: "this-machine" | "oneprovider" | "catalog-host" | "other";
  /** The catalog of an official API host (Groq, OpenRouter) */
  hostCatalog?: string;
  /** The catalog that describes the model's limits and controls */
  catalogProvider?: string;
  /** The model's entry in it */
  match?: CatalogMatch;
  /** A OneProvider `-thinking` id: the base model with thinking always on */
  thinkingAlwaysOn: boolean;
  /**
   * Where the prices come from. Unlike the limits, a custom `openai` host
   * keeps OpenAI's catalog here, as an estimate.
   */
  price: CatalogPriceRoute;
}

function priceRouteFor(
  provider: string,
  model: string,
  host: string | undefined,
  hostCatalog: string | undefined,
): CatalogPriceRoute {
  const catalogProvider = hostCatalog ?? catalogProviderFor(provider);
  const makerHost = MAKER_HOSTS[catalogProvider ?? ""];
  const offMakerHost =
    !!makerHost && !!host && !isHostOrSubdomain(host, makerHost);
  const routed =
    catalogProvider === "openrouter" && OPENROUTER_ROUTING.test(model);
  return {
    catalogProvider,
    model: routed ? model.replace(OPENROUTER_ROUTING, "") : model,
    source:
      offMakerHost || routed || isPlanHost(host)
        ? "estimated"
        : makerHost
          ? "exact"
          : "catalog",
  };
}

/**
 * The catalog that describes a model on an endpoint:
 *
 * - OneProvider (provider or host) isn't in the catalog: its models are the
 *   vendors' own, and a `-thinking` id is the base model with thinking on
 * - an official API host (api.groq.com, openrouter.ai) brings its catalog
 *   under any provider name
 * - `openai` is OpenAI's catalog only on OpenAI's API; any other host (a
 *   bridge, vLLM, a gateway) gets none, so its limits come from the config
 * - any other provider: its own catalog, if it has one
 * - Claude on Bedrock or an Anthropic proxy falls back to Anthropic's entry
 *
 * Prices (`price`) come from the host's catalog, else the provider's own:
 * a maker's list price is exact on the maker's API and estimated on any
 * other host, and OpenRouter's routing variants and subscription plans'
 * hosts are estimated.
 */
export function resolveCatalog({
  provider,
  model,
  apiBase,
}: ModelEndpoint): CatalogRoute {
  const host = hostOf(apiBase);
  const thisMachine = !!host && isLocalHost(host);
  const oneProvider = provider === "oneprovider" || isOneProviderBase(apiBase);
  const hostCatalog = oneProvider
    ? undefined
    : catalogProviderForApiBase(apiBase);
  const kind: CatalogRoute["host"] = oneProvider
    ? "oneprovider"
    : hostCatalog
      ? "catalog-host"
      : thisMachine
        ? "this-machine"
        : "other";

  if (oneProvider) {
    const thinkingAlwaysOn = /-thinking$/i.test(baseModelName(model));
    const name = withoutThinkingSuffix(model);
    const catalogProvider = vendorCatalogProvider(name);
    return {
      host: kind,
      catalogProvider,
      match: findCatalogModel(catalogProvider, name),
      thinkingAlwaysOn,
      // Priced from OneProvider's own table
      price: { model, source: "exact" },
    };
  }

  const catalogProvider =
    hostCatalog ??
    (provider === "openai"
      ? isOfficialOpenAI(apiBase)
        ? "openai"
        : undefined
      : catalogProviderFor(provider));
  let match = findCatalogModel(catalogProvider, model);
  if (
    !match &&
    (provider === "bedrock" || provider === "anthropic") &&
    isClaude(model)
  ) {
    // Bedrock's and proxies' Claude ids, through Anthropic's own entry
    match = findCatalogModel("anthropic", claudeNameOnBedrock(model));
  }
  return {
    host: kind,
    hostCatalog,
    catalogProvider,
    match,
    thinkingAlwaysOn: false,
    price: priceRouteFor(provider, model, host, hostCatalog),
  };
}

/**
 * Whether a model takes tools, as its endpoint's catalog says. Undefined
 * when that catalog doesn't list the model (a bridge or local server,
 * `openai` on another host, an unknown id). Core and the CLI ask it only
 * for providers without a tool rule of their own (core/llm/toolSupport.ts).
 */
export function catalogToolSupport(
  endpoint: ModelEndpoint,
): boolean | undefined {
  const { match } = resolveCatalog(endpoint);
  return match ? match.model.tools !== false : undefined;
}
