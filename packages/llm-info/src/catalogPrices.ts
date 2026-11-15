import { findCatalogModel } from "./catalog.js";
import type { CatalogCost } from "./catalogTypes.js";
import { CATALOG } from "./generated/catalog.js";

/** A provider's own price for a model, from the catalog */
export function findCatalogCost(
  catalogProvider: string | undefined,
  model: string,
): CatalogCost | undefined {
  return findCatalogModel(catalogProvider, model)?.model.cost;
}

/** A provider's price for the model's fast or priority mode, if it has one */
export function findCatalogFastCost(
  catalogProvider: string | undefined,
  model: string,
): CatalogCost | undefined {
  return findCatalogModel(catalogProvider, model)?.model.fast?.cost;
}

/** "deepseek/deepseek-v4.1-pro" -> "deepseek-v4-1-pro" */
function nameKey(model: string): string {
  const slash = model.lastIndexOf("/");
  return (slash === -1 ? model : model.slice(slash + 1))
    .toLowerCase()
    .replace(/\./g, "-");
}

// Dated snapshots and thinking or preview variants share their model's price
const VARIANT_SUFFIX =
  /^(?:-(?:\d{4}(?:-\d{2}){0,2}|\d{6,8}|thinking|preview|latest))+$/;

let generalPrices: Map<string, CatalogCost> | undefined;

/** OpenRouter's prices by model name, the highest when vendors share one */
function generalPriceIndex(): Map<string, CatalogCost> {
  if (!generalPrices) {
    generalPrices = new Map();
    for (const [id, model] of Object.entries(CATALOG.openrouter ?? {})) {
      // :free, :batch and similar are priced differently, and a free price
      // must never stand for a paid model
      if (id.includes(":") || !model.cost || model.cost.input <= 0) continue;
      const key = nameKey(id);
      const current = generalPrices.get(key);
      if (!current || model.cost.input > current.input) {
        generalPrices.set(key, model.cost);
      }
    }
  }
  return generalPrices;
}

/**
 * A general price for a model on a host without its own prices (a custom
 * gateway, a provider the catalog doesn't price): what
 * OpenRouter charges for a model of the same name. Names are compared
 * without the vendor prefix and with "." as "-", so "claude-opus-5-5" finds
 * "anthropic/claude-opus-5.5". When several vendors list the name, the
 * highest input price wins, so the estimate errs high. Free variants are
 * never used.
 */
export function findGeneralCost(model: string): CatalogCost | undefined {
  const index = generalPriceIndex();
  const key = nameKey(model);
  const exact = index.get(key);
  if (exact) return exact;
  let best: { key: string; cost: CatalogCost } | undefined;
  for (const [candidate, cost] of index) {
    if (
      key.startsWith(candidate) &&
      VARIANT_SUFFIX.test(key.slice(candidate.length)) &&
      (!best || candidate.length > best.key.length)
    ) {
      best = { key: candidate, cost };
    }
  }
  return best?.cost;
}
