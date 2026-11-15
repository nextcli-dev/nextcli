import type { CatalogModel } from "./catalogTypes.js";
import { CATALOG, CATALOG_SYNCED_AT } from "./generated/catalog.js";

export type {
  CatalogCost,
  CatalogModel,
  CatalogRates,
} from "./catalogTypes.js";
export { CATALOG_SYNCED_AT };

/**
 * The models.dev provider whose catalog entry describes a model configured
 * with this NextCLI provider. Providers that aren't listed (local servers,
 * OneProvider, custom OpenAI-compatible endpoints) have no catalog of their
 * own.
 */
export const CATALOG_PROVIDERS: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  azure: "azure",
  bedrock: "amazon-bedrock",
  cerebras: "cerebras",
  cohere: "cohere",
  deepinfra: "deepinfra",
  deepseek: "deepseek",
  fireworks: "fireworks-ai",
  gemini: "google",
  groq: "groq",
  inception: "inception",
  minimax: "minimax",
  mistral: "mistral",
  moonshot: "moonshotai",
  nebius: "nebius",
  novita: "novita-ai",
  nvidia: "nvidia",
  openai: "openai",
  openrouter: "openrouter",
  ovhcloud: "ovhcloud",
  sambanova: "sambanova",
  scaleway: "scaleway",
  together: "togetherai",
  vertexai: "google-vertex",
  xAI: "xai",
  zAI: "zai",
};

/** The models.dev provider for a NextCLI provider name, if it has one */
export function catalogProviderFor(provider: string): string | undefined {
  return CATALOG_PROVIDERS[provider];
}

/**
 * Suffixes a provider adds to a model id without changing the model: dated
 * snapshots and the thinking, preview and latest variants
 */
const VARIANT_SUFFIX =
  /^(?:-(?:\d{4}(?:-\d{2}){0,2}|\d{6,8}|thinking|preview|latest))+$/;

/** Claude ids come as claude-sonnet-4-6 and claude-sonnet-4.6 */
function normalize(id: string): string {
  return id.toLowerCase().replace(/\./g, "-");
}

const normalizedIndexes = new Map<string, Map<string, string>>();

function normalizedIndex(provider: string): Map<string, string> {
  let index = normalizedIndexes.get(provider);
  if (!index) {
    index = new Map();
    for (const id of Object.keys(CATALOG[provider] ?? {})) {
      const key = normalize(id);
      if (!index.has(key)) index.set(key, id);
    }
    normalizedIndexes.set(provider, index);
  }
  return index;
}

export interface CatalogMatch {
  /** The models.dev provider */
  provider: string;
  /** The catalog's id for the model */
  id: string;
  model: CatalogModel;
}

/**
 * A model's catalog entry, matched by its exact id, then case and dots
 * ignored, then without a vendor prefix (`anthropic/claude-…` on a provider
 * that isn't OpenRouter), then as a dated or preview variant of a listed id,
 * or a listed id as a variant of it.
 */
export function findCatalogModel(
  provider: string | undefined,
  model: string,
): CatalogMatch | undefined {
  if (!provider) return undefined;
  const models = CATALOG[provider];
  if (!models || !model) return undefined;
  const found = (id: string | undefined) =>
    id && models[id] ? { provider, id, model: models[id] } : undefined;

  const exact = found(model);
  if (exact) return exact;

  const index = normalizedIndex(provider);
  const candidates = [normalize(model)];
  const slash = model.lastIndexOf("/");
  if (provider !== "openrouter" && slash !== -1) {
    candidates.push(normalize(model.slice(slash + 1)));
  }
  for (const candidate of candidates) {
    const direct = found(index.get(candidate));
    if (direct) return direct;
  }
  for (const candidate of candidates) {
    // A dated variant of a listed id, or a listed variant of the id
    for (const [key, id] of index) {
      if (
        (candidate.startsWith(key) &&
          VARIANT_SUFFIX.test(candidate.slice(key.length))) ||
        (key.startsWith(candidate) &&
          VARIANT_SUFFIX.test(key.slice(candidate.length)))
      ) {
        return found(id);
      }
    }
  }
  return undefined;
}

/** Every provider's entries for the model, by its vendor's canonical id */
export function findCatalogModelsByCanonical(
  canonical: string,
): CatalogMatch[] {
  const key = normalize(canonical);
  const matches: CatalogMatch[] = [];
  for (const [provider, models] of Object.entries(CATALOG)) {
    for (const [id, model] of Object.entries(models)) {
      if (model.canonical && normalize(model.canonical) === key) {
        matches.push({ provider, id, model });
      }
    }
  }
  return matches;
}
