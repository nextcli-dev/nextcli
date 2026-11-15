import {
  CATALOG_PROVIDERS,
  catalogProviderFor,
  catalogProviderForApiBase,
  findCatalogModel,
  type CatalogModel,
} from "@nextcli/llm-info";

import { supportsFimEndpoint } from "./fimEndpoints.js";
import type { ControlsFormat, ModelIdentity } from "./modelControls.js";

/**
 * What NextCLI knows about a model on a given endpoint: the request format
 * its controls are written in, the catalog entry that describes it (from the
 * models.dev snapshot in @nextcli/llm-info), and what the endpoint serves.
 */
export interface ModelProfile {
  /** The request format of the model's controls; follows the adapter */
  format: ControlsFormat;
  /** The models.dev provider that describes the model, if any */
  catalogProvider?: string;
  /** The model's catalog entry, if the catalog lists it */
  catalog?: CatalogModel;
  /** The endpoint serves fill-in-the-middle completions */
  fim: boolean;
  /** A OneProvider `-thinking` id: the base model with thinking always on */
  thinkingAlwaysOn: boolean;
}

const OPENAI_API_BASE = "https://api.openai.com/v1/";
const ONEPROVIDER_PROVIDER = "oneprovider";

/** Strips a vendor prefix such as `anthropic/` (OpenRouter model ids) */
export function baseModelName(model: string): string {
  const slash = model.lastIndexOf("/");
  return (slash === -1 ? model : model.slice(slash + 1)).toLowerCase();
}

export function isClaude(model: string): boolean {
  return baseModelName(model).includes("claude");
}

function isDeepSeek(model: string): boolean {
  return baseModelName(model).startsWith("deepseek");
}

function isOfficialOpenAI(apiBase: string | undefined): boolean {
  return !apiBase || apiBase.replace(/\/?$/, "/") === OPENAI_API_BASE;
}

/** Whether an API base is OneProvider's, whichever provider id the config uses */
export function isOneProviderBase(apiBase: string | undefined): boolean {
  try {
    const host = new URL(apiBase ?? "").hostname;
    return host === "oneprovider.dev" || host.endsWith(".oneprovider.dev");
  } catch {
    return false;
  }
}

function isOneProvider({ provider, apiBase }: ModelIdentity): boolean {
  return provider === ONEPROVIDER_PROVIDER || isOneProviderBase(apiBase);
}

/** The request format for a model, following the adapter it goes through */
export function getControlsFormat({
  provider,
  model,
  apiBase,
}: ModelIdentity): ControlsFormat {
  switch (provider) {
    case "anthropic":
      return "anthropic";
    case ONEPROVIDER_PROVIDER:
      // Claude goes through OneProvider's Anthropic Messages endpoint;
      // DeepSeek models go through its OpenAI-compatible endpoint but still
      // use DeepSeek's own thinking controls
      if (isClaude(model)) return "anthropic";
      return isDeepSeek(model) ? "deepseek" : "generic";
    case "openai":
      if (isOfficialOpenAI(apiBase)) return "openai";
      // An OpenAI-compatible config pointed at OneProvider (what nextcli-checks
      // writes) is the same endpoint as provider "oneprovider", which takes
      // DeepSeek's own thinking switch (`thinking: { type: "disabled" }`)
      return isOneProviderBase(apiBase) && isDeepSeek(model)
        ? "deepseek"
        : "generic";
    case "openrouter":
      return "openrouter";
    case "deepseek":
      return "deepseek";
    case "moonshot":
      return "moonshot";
    case "gemini":
      return "gemini";
    case "bedrock":
      return "bedrock";
    case "xAI":
    case "xai":
      return "xai";
    case "azure":
      return "azure";
    default:
      return "generic";
  }
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

/** The model's entry in its vendor's own catalog */
export function vendorCatalogModel(model: string): CatalogModel | undefined {
  const name = withoutThinkingSuffix(model);
  return findCatalogModel(vendorCatalogProvider(name), baseModelName(name))
    ?.model;
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

function withoutThinkingSuffix(model: string): string {
  return model.replace(/-thinking$/i, "");
}

/** The models.dev provider that describes a model on this endpoint */
function catalogProviderForEndpoint(
  identity: ModelIdentity,
): string | undefined {
  if (isOneProvider(identity)) {
    // OneProvider isn't in the catalog; its models are the vendors' own
    return vendorCatalogProvider(identity.model);
  }
  // An official API host keeps its catalog under any provider name: Groq
  // set up as an OpenAI-compatible endpoint is still Groq
  const hostCatalog = catalogProviderForApiBase(identity.apiBase);
  if (hostCatalog) {
    return hostCatalog;
  }
  if (identity.provider === "openai") {
    // A custom OpenAI-compatible endpoint (a bridge, vLLM, a gateway) gets
    // no tables: its limits come from the config
    return isOfficialOpenAI(identity.apiBase) ? "openai" : undefined;
  }
  return catalogProviderFor(identity.provider);
}

export function resolveModelProfile(identity: ModelIdentity): ModelProfile {
  const format = getControlsFormat(identity);
  const oneProvider = isOneProvider(identity);
  const thinkingAlwaysOn =
    oneProvider && /-thinking$/i.test(baseModelName(identity.model));
  const model = oneProvider
    ? withoutThinkingSuffix(identity.model)
    : identity.model;
  const catalogProvider = catalogProviderForEndpoint(identity);

  let catalog = findCatalogModel(catalogProvider, model)?.model;
  if (!catalog && (format === "bedrock" || format === "anthropic")) {
    // Bedrock's and proxies' Claude ids, through Anthropic's own entry
    catalog = isClaude(model)
      ? findCatalogModel("anthropic", claudeNameOnBedrock(model))?.model
      : undefined;
  }

  return {
    format,
    catalogProvider,
    catalog,
    fim: supportsFimEndpoint(identity.provider, identity.apiBase),
    thinkingAlwaysOn,
  };
}
