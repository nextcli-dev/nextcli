import type { CatalogModel } from "./catalogTypes.js";
import { CATALOG, CATALOG_SYNCED_AT } from "./generated/catalog.js";
import { SUPPLEMENT } from "./supplement.js";

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
 * A pattern for the suffixes a provider adds to a model id without changing
 * the model: dated snapshots (-2024-08-06, -20250514, Mistral's -2512) and
 * the thinking, preview and latest variants, plus any `extra` ones (a host's
 * own effort suffixes, for example)
 */
export function variantSuffix(extra: readonly string[] = []): RegExp {
  const words = ["thinking", "preview", "latest", ...extra].join("|");
  return new RegExp(`^(?:-(?:\\d{4}(?:-\\d{2}){0,2}|\\d{6,8}|${words}))+$`);
}

const VARIANT_SUFFIX = variantSuffix();

/**
 * The longest of `keys` that `name` extends by variant suffixes only
 * (gpt-5.5-2026-04-23 finds gpt-5.5), if any. A different model, such as
 * gpt-5.5-pro, doesn't match gpt-5.5.
 */
export function longestListedBase(
  name: string,
  keys: Iterable<string>,
  suffix: RegExp = VARIANT_SUFFIX,
): string | undefined {
  let base: string | undefined;
  for (const key of keys) {
    if (
      (!base || key.length > base.length) &&
      name.startsWith(key) &&
      suffix.test(name.slice(key.length))
    ) {
      base = key;
    }
  }
  return base;
}

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

/** Models by provider and id, the shape of the snapshot and the supplement */
export type Catalog = Record<string, Record<string, CatalogModel>>;

const normalizedIndexes = new WeakMap<
  Catalog,
  Map<string, Map<string, string>>
>();

function normalizedIndex(
  catalog: Catalog,
  provider: string,
): Map<string, string> {
  let byProvider = normalizedIndexes.get(catalog);
  if (!byProvider) {
    byProvider = new Map();
    normalizedIndexes.set(catalog, byProvider);
  }
  let index = byProvider.get(provider);
  if (!index) {
    index = new Map();
    for (const id of Object.keys(catalog[provider] ?? {})) {
      const key = normalize(id);
      if (!index.has(key)) index.set(key, id);
    }
    byProvider.set(provider, index);
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
 * A model's catalog entry: the models.dev snapshot's, else NextCLI's own
 * (supplement.ts), as matchCatalogs orders them
 */
export function findCatalogModel(
  provider: string | undefined,
  model: string,
): CatalogMatch | undefined {
  return matchCatalogs([CATALOG, SUPPLEMENT], provider, model);
}

/**
 * The models.dev snapshot's entry for this very model, without variant
 * matches or the supplement
 */
export function findModelsDevModel(
  provider: string | undefined,
  model: string,
): CatalogMatch | undefined {
  return matchCatalogs([CATALOG], provider, model, { variants: false });
}

/**
 * A model's entry in the first of `catalogs` that lists it, with an entry for
 * the model itself winning over a variant's in any catalog. The model itself
 * is matched by its exact id, then case and dots ignored, then without a
 * vendor prefix (`anthropic/claude-…` on a provider that isn't OpenRouter).
 * With `variants` (the default), it is then matched as a dated or preview
 * variant of a listed id (the longest such id), then as an id some listed
 * variants extend: the `-latest` alias first, then the newest current
 * snapshot (variantRank).
 */
export function matchCatalogs(
  catalogs: Catalog[],
  provider: string | undefined,
  model: string,
  { variants = true }: { variants?: boolean } = {},
): CatalogMatch | undefined {
  if (!provider || !model) return undefined;
  const candidates = [normalize(model)];
  const slash = model.lastIndexOf("/");
  if (provider !== "openrouter" && slash !== -1) {
    candidates.push(normalize(model.slice(slash + 1)));
  }
  for (const catalog of catalogs) {
    const match = matchModel(catalog, provider, model, candidates);
    if (match) return match;
  }
  if (!variants) return undefined;
  for (const catalog of catalogs) {
    const match = matchVariant(catalog, provider, candidates);
    if (match) return match;
  }
  return undefined;
}

function entry(
  catalog: Catalog,
  provider: string,
  id: string | undefined,
): CatalogMatch | undefined {
  const models = catalog[provider];
  return id && models?.[id]
    ? { provider, id, model: withAliasFast(models, id) }
    : undefined;
}

/** The entry for the model itself: its id, normalized or without a prefix */
function matchModel(
  catalog: Catalog,
  provider: string,
  model: string,
  candidates: string[],
): CatalogMatch | undefined {
  const exact = entry(catalog, provider, model);
  if (exact) return exact;
  const index = normalizedIndex(catalog, provider);
  for (const candidate of candidates) {
    const direct = entry(catalog, provider, index.get(candidate));
    if (direct) return direct;
  }
  return undefined;
}

/** The entry of a listed id the model is a variant of, or of its variants */
function matchVariant(
  catalog: Catalog,
  provider: string,
  candidates: string[],
): CatalogMatch | undefined {
  const models = catalog[provider];
  if (!models) return undefined;
  const index = normalizedIndex(catalog, provider);
  for (const candidate of candidates) {
    // A dated variant of a listed id: the most specific listed id
    const base = longestListedBase(candidate, index.keys());
    if (base) return entry(catalog, provider, index.get(base));

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
    if (best) return entry(catalog, provider, best.id);
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
