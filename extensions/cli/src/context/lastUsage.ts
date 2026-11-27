import type { Usage } from "core/index.js";

let lastResponseUsage: Usage | undefined;

/**
 * The provider usage of the latest kept model response, not an estimate,
 * a discarded retry, or the compaction summary.
 */
export function rememberResponseUsage(usage: Usage): void {
  lastResponseUsage = usage;
}

/** /clear and /resume: the stored call belongs to a different history. */
export function clearLastResponseUsage(): void {
  lastResponseUsage = undefined;
}

export function getLastResponseUsage(): Usage | undefined {
  return lastResponseUsage;
}

/** Cache reads as a share of prompt tokens, as a whole percentage */
export function cacheHitPercent(usage: Usage): string {
  const cached = usage.promptTokensDetails?.cachedTokens ?? 0;
  return usage.promptTokens > 0
    ? `${Math.round((cached / usage.promptTokens) * 100)}%`
    : "0%";
}
