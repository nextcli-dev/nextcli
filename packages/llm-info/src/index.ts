import { Anthropic } from "./providers/anthropic.js";
import { Azure } from "./providers/azure.js";
import { Bedrock } from "./providers/bedrock.js";
import { Cohere } from "./providers/cohere.js";
import { CometAPI } from "./providers/cometapi.js";
import { DeepSeek } from "./providers/deepseek.js";
import { Gemini } from "./providers/gemini.js";
import { Inception } from "./providers/inception.js";
import { MiniMax } from "./providers/minimax.js";
import { Mistral } from "./providers/mistral.js";
import { Ollama } from "./providers/ollama.js";
import { OpenAi } from "./providers/openai.js";
import { Vllm } from "./providers/vllm.js";
import { Voyage } from "./providers/voyage.js";
import { xAI } from "./providers/xAI.js";
import { zAI } from "./providers/zai.js";
import { catalogPromptLimit } from "./catalog.js";
import { resolveCatalog } from "./endpoint.js";
import {
  LlmInfoWithProvider,
  MediaType,
  ModelProvider,
  UseCase,
} from "./types.js";

export {
  CATALOG_PROVIDERS,
  CATALOG_SYNCED_AT,
  catalogPromptLimit,
  catalogProviderFor,
  findCatalogModel,
  variantSuffix,
} from "./catalog.js";
export {
  baseModelName,
  CATALOG_HOSTS,
  catalogProviderForApiBase,
  hostOf,
  isClaude,
  isHostOrSubdomain,
  isLocalHost,
  isOneProviderBase,
  resolveCatalog,
  vendorCatalogMatch,
  vendorCatalogProvider,
  withoutThinkingSuffix,
} from "./endpoint.js";
export type { CatalogRoute, ModelEndpoint } from "./endpoint.js";
export {
  findCatalogCost,
  findCatalogFastCost,
  findGeneralCost,
  hasUnknownZeroPrice,
} from "./catalogPrices.js";
export type {
  CatalogCost,
  CatalogMatch,
  CatalogModel,
  CatalogRates,
} from "./catalog.js";
export { isRetired } from "./types.js";
export type { LlmDeprecation } from "./types.js";

export const allModelProviders: ModelProvider[] = [
  OpenAi,
  Gemini,
  Anthropic,
  Mistral,
  Voyage,
  Azure,
  Ollama,
  Vllm,
  Bedrock,
  Cohere,
  CometAPI,
  DeepSeek,
  Inception,
  MiniMax,
  xAI,
  zAI,
];

export const allLlms: LlmInfoWithProvider[] = allModelProviders.flatMap(
  (provider) =>
    provider.models.map((model) => ({ ...model, provider: provider.id })),
);

/**
 * A model's limits and media types. The hand-written provider tables come
 * first for the models they list, with the context window they leave out
 * taken from the models.dev catalog snapshot (npm run sync-models) and
 * capped at its input limit; the catalog alone covers the rest of the
 * preferred provider's models.
 */
export function findLlmInfo(
  model: string,
  preferProviderId?: string,
  /** The model's API base: the host decides which catalog applies */
  apiBase?: string,
): LlmInfoWithProvider | undefined {
  if (preferProviderId) {
    const provider = allModelProviders.find((p) => p.id === preferProviderId);
    const info = provider?.models.find((llm) =>
      llm.regex ? llm.regex.test(model) : llm.model === model,
    );
    const fromCatalog = llmInfoFromCatalog(model, preferProviderId, apiBase);
    if (info) {
      // The catalog fills a context window the row leaves out, and its input
      // limit caps one the row states. The row's output limit is kept as it
      // is: it sets the default max_tokens requests send.
      const contextLength = info.contextLength ?? fromCatalog?.contextLength;
      const promptLimit = fromCatalog?.contextLength;
      return {
        ...info,
        provider: preferProviderId,
        ...(contextLength !== undefined && {
          contextLength:
            promptLimit !== undefined
              ? Math.min(contextLength, promptLimit)
              : contextLength,
        }),
      };
    }
    if (fromCatalog) {
      return fromCatalog;
    }
  }
  return allLlms.find((llm) =>
    llm.regex ? llm.regex.test(model) : llm.model === model,
  );
}

/**
 * A model's limits from the catalog that describes it on this endpoint. The
 * catalog's output limit isn't used: many entries list the whole window as
 * the output limit, and it would become the default max_tokens.
 */
function llmInfoFromCatalog(
  model: string,
  provider: string,
  apiBase: string | undefined,
): LlmInfoWithProvider | undefined {
  const { match } = resolveCatalog({ provider, model, apiBase });
  if (!match) {
    return undefined;
  }
  const contextLength = catalogPromptLimit(match.model);
  return {
    model,
    provider,
    ...(contextLength !== undefined && { contextLength }),
    ...(match.model.images && {
      mediaTypes: [MediaType.Text, MediaType.Image],
    }),
  };
}

export function getAllRecommendedFor(useCase: UseCase): LlmInfoWithProvider[] {
  return allLlms.filter((llm) => llm.recommendedFor?.includes(useCase));
}
