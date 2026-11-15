/**
 * Corrections to the models.dev catalog (@nextcli/llm-info) that were
 * checked against the live APIs. Each says what was checked and when.
 * Remove one once the catalog agrees with it.
 */

interface EffortOverride {
  /** Model names it applies to, without a vendor prefix */
  models: RegExp;
  /** The effort levels to offer instead of the catalog's */
  efforts: string[];
  checked: string;
}

const EFFORT_OVERRIDES: Record<"xai" | "deepseek", EffortOverride[]> = {
  xai: [
    {
      models: /^grok-4\.[3-7](?!\d)/,
      efforts: ["minimal", "low", "medium", "high", "xhigh"],
      checked:
        "Live xAI API, 2026-11-04: grok-4.3 to 4.7 take minimal; the catalog leaves it out",
    },
  ],
  deepseek: [
    {
      models: /^deepseek/,
      efforts: [],
      checked:
        "DeepSeek's API and OneProvider, 2026-11-04: only turning thinking off is verified; the catalog's low, high and max aren't",
    },
  ],
};

/** The overridden effort levels for a model, if a correction applies */
export function overriddenEfforts(
  family: keyof typeof EFFORT_OVERRIDES,
  modelName: string,
): string[] | undefined {
  return EFFORT_OVERRIDES[family].find(({ models }) => models.test(modelName))
    ?.efforts;
}
