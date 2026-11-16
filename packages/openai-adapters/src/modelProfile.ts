import {
  baseModelName,
  isClaude,
  isOneProviderBase,
  resolveCatalog,
  vendorCatalogMatch,
  vendorCatalogProvider,
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

// Moved to @nextcli/llm-info (endpoint.ts), so the menus, limits and prices
// share them
export { baseModelName, isClaude, isOneProviderBase, vendorCatalogProvider };

function isDeepSeek(model: string): boolean {
  return baseModelName(model).startsWith("deepseek");
}

function isOfficialOpenAI(apiBase: string | undefined): boolean {
  return !apiBase || apiBase.replace(/\/?$/, "/") === OPENAI_API_BASE;
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

/** The model's entry in its vendor's own catalog */
export function vendorCatalogModel(model: string): CatalogModel | undefined {
  return vendorCatalogMatch(model)?.model;
}

/**
 * The model's format, catalog entry and FIM support on its endpoint. Which
 * catalog describes it is resolveCatalog's answer in @nextcli/llm-info.
 */
export function resolveModelProfile(identity: ModelIdentity): ModelProfile {
  const route = resolveCatalog(identity);
  return {
    format: getControlsFormat(identity),
    catalogProvider: route.catalogProvider,
    catalog: route.match?.model,
    fim: supportsFimEndpoint(identity.provider, identity.apiBase),
    thinkingAlwaysOn: route.thinkingAlwaysOn,
  };
}
