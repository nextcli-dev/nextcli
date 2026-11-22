import type { CatalogModel } from "./catalogTypes.js";

/**
 * NextCLI's own descriptions of models the models.dev snapshot
 * (generated/catalog.ts) doesn't list yet, in the same shape and under the
 * same models.dev provider ids. The sync never writes this file.
 *
 * findCatalogModel prefers an exact match in either catalog to a variant
 * match, and models.dev to this file at the same strength. Above each entry,
 * say where its values come from and when they were read. Delete an entry
 * once models.dev lists the model: a test in openai-adapters
 * (modelProfile.test.ts) fails when it does, and the weekly sync pull request
 * lists that test.
 *
 * Dated, `-preview` and `-thinking` ids reach an entry through the variant
 * rule (variantSuffix) and take its limits and prices. Add the variant as
 * its own entry when its source gives different ones.
 *
 * Leave out what the source doesn't say. On an OpenAI-compatible (generic)
 * endpoint, an absent `efforts` makes the menu offer guessed levels marked
 * as a guess.
 */
export const SUPPLEMENT: Record<string, Record<string, CatalogModel>> = {
  alibaba: {
    // https://www.qwencloud.com/models/qwen4-max, read 2026-11-19: limits,
    // image input and prices. The page doesn't list the effort levels the
    // API takes, or a qwen4-max-preview of its own.
    "qwen4-max": {
      context: 1_000_000,
      // 983K with thinking (991K without): the smaller, so a prompt fits
      // either way
      input: 983_000,
      reasoning: true,
      // Live check of qwen4-max and qwen4-max-preview on the token-plan
      // endpoint (compatible-mode/v1), 2026-11-22: an unknown
      // reasoning_effort is rejected with "must be one of: 'none', 'off',
      // 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'"; "none" returns
      // no reasoning tokens. "off" is left out as the same as "none".
      // DashScope international and the coding plan use this entry too, but
      // weren't checked: both refused the token-plan key (401), and each
      // host checks the key before the request body.
      efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      images: true,
      cost: { input: 1.5, output: 4.5, cacheRead: 0.075, cacheWrite: 1.875 },
    },
  },
};
