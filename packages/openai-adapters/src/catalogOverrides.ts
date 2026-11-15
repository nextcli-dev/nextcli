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

interface OffOverride {
  /** Model names it applies to, without a vendor prefix */
  models: RegExp;
  checked: string;
}

/**
 * Models whose API rejects turning reasoning off, though the catalog lists
 * "none" among their efforts. Sending it would fail with a 400, while
 * leaving Off out of the menu only hides an option.
 */
const REASONING_OFF_REJECTED: Record<"openai", OffOverride[]> = {
  openai: [
    {
      models: /^gpt-6\.1(?!\d)/,
      checked:
        "Live OpenAI Responses API, 2026-11-04: gpt-6.1 rejects reasoning_effort none; the catalog lists none for gpt-6.1-terra. Lift after a live check of each variant.",
    },
  ],
};

/** Whether the API rejects turning reasoning off for the model */
export function reasoningOffRejected(
  family: keyof typeof REASONING_OFF_REJECTED,
  modelName: string,
): boolean {
  return REASONING_OFF_REJECTED[family].some(({ models }) =>
    models.test(modelName),
  );
}
