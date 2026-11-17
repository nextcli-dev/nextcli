/** Prices in US dollars per million tokens */
export interface CatalogRates {
  input: number;
  output: number;
  /** Cached prompt tokens read; when absent they cost the input price */
  cacheRead?: number;
  /** Prompt tokens written to the cache */
  cacheWrite?: number;
}

export interface CatalogCost extends CatalogRates {
  /** Higher prices once the prompt is longer than `above` tokens */
  tiers?: Array<CatalogRates & { above: number }>;
}

/**
 * One model, as the models.dev catalog describes it, trimmed to the fields
 * NextCLI uses. A field that's absent is unknown or false.
 */
export interface CatalogModel {
  /** Context window, in tokens */
  context?: number;
  /** Longest prompt, when it is shorter than the context window */
  input?: number;
  reasoning?: true;
  /**
   * Reasoning effort values the API takes, lowest first. "none" means
   * reasoning can be turned off through the effort.
   */
  efforts?: string[];
  /** Takes image input */
  images?: true;
  /** Doesn't take tools (function calling); absent, it does */
  tools?: false;
  /** The model has a fast or priority mode, with its prices when known */
  fast?: { cost?: CatalogRates };
  cost?: CatalogCost;
  /** The vendor deprecated the model */
  deprecated?: true;
}
