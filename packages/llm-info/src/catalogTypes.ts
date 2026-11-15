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
  /** Longest output */
  output?: number;
  reasoning?: true;
  /**
   * Reasoning effort values the API takes, lowest first. "none" means
   * reasoning can be turned off through the effort.
   */
  efforts?: string[];
  /** Reasoning can be switched on and off */
  toggle?: true;
  /** A thinking budget, in tokens */
  budget?: { min?: number; max?: number };
  tools?: true;
  images?: true;
  /** False when the API rejects `temperature` */
  temperature?: false;
  /** The message field reasoning is sent back in, e.g. reasoning_content */
  interleaved?: string;
  /** A fast mode: the request fields that turn it on, and its prices */
  fast?: {
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    cost?: CatalogRates;
  };
  cost?: CatalogCost;
  /** The vendor deprecated the model */
  deprecated?: true;
  /** The vendor's own id, when this provider names the model differently */
  canonical?: string;
}
