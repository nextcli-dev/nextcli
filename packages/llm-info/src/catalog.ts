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

/**
 * Official API hosts whose models.dev catalog applies whichever provider the
 * config names: Groq set up as an OpenAI-compatible endpoint is still Groq
 */
export const CATALOG_HOSTS: Readonly<Record<string, string>> = {
  "api.groq.com": "groq",
};

/** The models.dev provider of an API base's host, if it is an official one */
export function catalogProviderForApiBase(
  apiBase: string | undefined,
): string | undefined {
  if (!apiBase) return undefined;
  try {
    return CATALOG_HOSTS[new URL(apiBase).hostname.toLowerCase()];
  } catch {
    return undefined;
  }
}

/**
 * The models.dev provider for a NextCLI provider name, if it has one. Names
 * are matched without case, so "xai" finds xAI's catalog.
 */
export function catalogProviderFor(
  provider: string | undefined,
): string | undefined {
  if (!provider) return undefined;
  if (CATALOG_PROVIDERS[provider]) return CATALOG_PROVIDERS[provider];
  const lower = provider.toLowerCase();
  return Object.entries(CATALOG_PROVIDERS).find(
    ([name]) => name.toLowerCase() === lower,
  )?.[1];
}

/**
 * Suffixes a provider adds to a model id without changing the model: dated
 * snapshots and the thinking, preview and latest variants
 */
const VARIANT_SUFFIX =
  /^(?:-(?:\d{4}(?:-\d{2}){0,2}|\d{6,8}|thinking|preview|latest))+$/;

/** A dated snapshot suffix: -2024-08-06, -20250514, or Mistral's -2512 */
const DATE_SUFFIX = /-(?:\d{4}(?:-\d{2}){0,2}|\d{6,8})$/;

/**
 * How well a listed variant stands for an id given without a suffix, lower
 * is better: the provider's `-latest` alias, then a current snapshot, then a
 * deprecated one, then a thinking or preview variant (a different mode,
 * often priced differently)
 */
function variantRank(suffix: string, model: CatalogModel): number {
  if (/-latest\b/.test(suffix)) return 0;
  if (/-(?:thinking|preview)\b/.test(suffix)) return 3;
  return model.deprecated ? 2 : 1;
}

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
 * The entry, with the fast mode of its undated alias when a dated snapshot
 * lists none of its own (OpenAI lists priority for gpt-4o, not for
 * gpt-4o-2024-08-06). The alias's fast prices come along only when the two
 * have the same standard price.
 */
function withAliasFast(
  models: Record<string, CatalogModel>,
  id: string,
): CatalogModel {
  const model = models[id];
  const alias = DATE_SUFFIX.test(id)
    ? models[id.replace(DATE_SUFFIX, "")]
    : undefined;
  if (model.fast || !alias?.fast) return model;
  const samePrice =
    model.cost?.input === alias.cost?.input &&
    model.cost?.output === alias.cost?.output;
  const { cost, ...fast } = alias.fast;
  return { ...model, fast: samePrice && cost ? { ...fast, cost } : fast };
}

/**
 * A model's catalog entry, matched by its exact id, then case and dots
 * ignored, then without a vendor prefix (`anthropic/claude-…` on a provider
 * that isn't OpenRouter), then as a dated or preview variant of a listed id
 * (the longest such id), then as an id some listed variants extend: the
 * `-latest` alias first, then the newest current snapshot (variantRank).
 */
export function findCatalogModel(
  provider: string | undefined,
  model: string,
): CatalogMatch | undefined {
  if (!provider) return undefined;
  const models = CATALOG[provider];
  if (!models || !model) return undefined;
  const found = (id: string | undefined) =>
    id && models[id]
      ? { provider, id, model: withAliasFast(models, id) }
      : undefined;

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
    // A dated variant of a listed id: the most specific listed id
    let base: string | undefined;
    for (const key of index.keys()) {
      if (
        candidate.startsWith(key) &&
        VARIANT_SUFFIX.test(candidate.slice(key.length)) &&
        (!base || key.length > base.length)
      ) {
        base = key;
      }
    }
    if (base) return found(index.get(base));

    // Listed variants of the id: the best ranked, then the newest
    let best: { id: string; rank: number; suffix: string } | undefined;
    for (const [key, id] of index) {
      const suffix = key.slice(candidate.length);
      if (!key.startsWith(candidate) || !VARIANT_SUFFIX.test(suffix)) {
        continue;
      }
      const rank = variantRank(suffix, models[id]);
      if (
        !best ||
        rank < best.rank ||
        (rank === best.rank && suffix > best.suffix)
      ) {
        best = { id, rank, suffix };
      }
    }
    if (best) return found(best.id);
  }
  return undefined;
}

/**
 * The longest prompt the model takes, in tokens: its input limit when the
 * catalog gives one below the context window (GPT-5.5 has a 1,050,000-token
 * window but takes at most 922,000 tokens of input), else the window
 */
export function catalogPromptLimit(model: CatalogModel): number | undefined {
  if (model.input !== undefined && model.context !== undefined) {
    return Math.min(model.input, model.context);
  }
  return model.input ?? model.context;
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
