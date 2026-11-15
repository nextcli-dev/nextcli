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
import { catalogProviderFor, findCatalogModel } from "./catalog.js";
import {
  LlmInfoWithProvider,
  MediaType,
  ModelProvider,
  UseCase,
} from "./types.js";

export {
  CATALOG_PROVIDERS,
  CATALOG_SYNCED_AT,
  catalogProviderFor,
  findCatalogModel,
  findCatalogModelsByCanonical,
} from "./catalog.js";
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
 * first for the models they list; the models.dev catalog snapshot
 * (npm run sync-models) covers the rest of the preferred provider's models.
 */
export function findLlmInfo(
  model: string,
  preferProviderId?: string,
): LlmInfoWithProvider | undefined {
  if (preferProviderId) {
    const provider = allModelProviders.find((p) => p.id === preferProviderId);
    const info = provider?.models.find((llm) =>
      llm.regex ? llm.regex.test(model) : llm.model === model,
    );
    if (info) {
      return {
        ...info,
        provider: preferProviderId,
      };
    }
    const fromCatalog = llmInfoFromCatalog(model, preferProviderId);
    if (fromCatalog) {
      return fromCatalog;
    }
  }
  return allLlms.find((llm) =>
    llm.regex ? llm.regex.test(model) : llm.model === model,
  );
}

function llmInfoFromCatalog(
  model: string,
  provider: string,
): LlmInfoWithProvider | undefined {
  const match = findCatalogModel(catalogProviderFor(provider), model);
  if (!match) {
    return undefined;
  }
  const { context, output, images } = match.model;
  return {
    model,
    provider,
    ...(context !== undefined && { contextLength: context }),
    ...(output !== undefined && { maxCompletionTokens: output }),
    ...(images && { mediaTypes: [MediaType.Text, MediaType.Image] }),
  };
}

export function getAllRecommendedFor(useCase: UseCase): LlmInfoWithProvider[] {
  return allLlms.filter((llm) => llm.recommendedFor?.includes(useCase));
}
