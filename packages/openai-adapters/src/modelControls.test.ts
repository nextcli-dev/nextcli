import { CATALOG } from "@nextcli/llm-info/dist/generated/catalog.js";
import { describe, expect, it } from "vitest";

import { anthropicEffortLevels } from "./apis/AnthropicUtils.js";
import {
  buildModelControlFields,
  chosenThinkingMode,
  clampEffort,
  effectiveThinkingMode,
  formatContextLength,
  getContextOptions,
  getControlsFormat,
  getModelControls,
  looksLikeReasoningModel,
  parseGeminiModelVersion,
} from "./modelControls.js";

describe("getControlsFormat", () => {
  it("follows the adapter the request goes through", () => {
    expect(
      getControlsFormat({ provider: "anthropic", model: "claude-opus-5-5" }),
    ).toBe("anthropic");
    expect(getControlsFormat({ provider: "openai", model: "gpt-5.5" })).toBe(
      "openai",
    );
    // OpenAI-compatible config pointed at OneProvider: the same endpoint as
    // provider "oneprovider", so DeepSeek keeps its own thinking switch
    expect(
      getControlsFormat({
        provider: "openai",
        model: "deepseek-v4-pro",
        apiBase: "https://api.oneprovider.dev/v1",
      }),
    ).toBe("deepseek");
    // Other models and other hosts stay generic
    expect(
      getControlsFormat({
        provider: "openai",
        model: "gpt-6.1-sol",
        apiBase: "https://api.oneprovider.dev/v1",
      }),
    ).toBe("generic");
    expect(
      getControlsFormat({
        provider: "openai",
        model: "deepseek-v4-pro",
        apiBase: "https://llm.example.com/v1",
      }),
    ).toBe("generic");
    expect(
      getControlsFormat({
        provider: "openai",
        model: "deepseek-v4-pro",
        apiBase: "https://oneprovider.dev.evil.example/v1",
      }),
    ).toBe("generic");
    expect(
      getControlsFormat({
        provider: "oneprovider",
        model: "claude-sonnet-5-5",
      }),
    ).toBe("anthropic");
    expect(
      getControlsFormat({ provider: "oneprovider", model: "gpt-6.1-sol" }),
    ).toBe("generic");
    expect(
      getControlsFormat({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-5-5",
      }),
    ).toBe("openrouter");
  });
});

describe("DeepSeek on OneProvider through an OpenAI-compatible config", () => {
  const identity = {
    provider: "openai",
    model: "deepseek-v4-pro",
    apiBase: "https://api.oneprovider.dev/v1",
  };

  it("can turn thinking off", () => {
    expect(getModelControls(identity).thinkingModes).toContain("off");
  });

  it("asks the provider to stop thinking when Off is chosen", () => {
    // OneProvider also needs reasoning_effort "none": `thinking` alone still
    // returned reasoning for a request with tool calls in its history
    expect(buildModelControlFields(identity, { thinking: "off" })).toEqual({
      thinking: { type: "disabled" },
      reasoning_effort: "none",
    });
    expect(
      buildModelControlFields(
        { provider: "oneprovider", model: "deepseek-v4-pro" },
        { thinking: "off" },
      ),
    ).toEqual({ thinking: { type: "disabled" }, reasoning_effort: "none" });
    // DeepSeek's own API keeps its documented switch only
    expect(
      buildModelControlFields(
        { provider: "deepseek", model: "deepseek-v4-pro" },
        { thinking: "off" },
      ),
    ).toEqual({ thinking: { type: "disabled" } });
    expect(buildModelControlFields(identity, {})).toEqual({});
  });
});

describe("getModelControls", () => {
  it("lists Claude effort levels, fast mode and context per model", () => {
    expect(
      getModelControls({ provider: "anthropic", model: "claude-opus-5-5" }),
    ).toEqual({
      format: "anthropic",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      // Opus 5.5 rejects `thinking: disabled`
      thinkingModes: ["hidden", "shown"],
      thinkingUnavailable: {
        off: "This model always thinks; it can't be turned off.",
      },
      defaultThinking: "shown",
      canShowThinking: true,
      thinkingNeedsEffort: false,
      effortNeedsThinking: false,
      fast: true,
      maxContextLength: 1_000_000,
      experimental: false,
    });
    expect(
      getModelControls({ provider: "anthropic", model: "claude-haiku-4-5" }),
    ).toMatchObject({
      efforts: ["low", "medium", "high"],
      fast: false,
      maxContextLength: 200_000,
    });
  });

  it("marks Claude 4.6 to 4.8 thinking as needing an effort", () => {
    expect(
      getModelControls({ provider: "anthropic", model: "claude-sonnet-4-6" })
        .thinkingNeedsEffort,
    ).toBe(true);
    expect(
      getModelControls({ provider: "anthropic", model: "claude-opus-4-8" })
        .thinkingNeedsEffort,
    ).toBe(true);
    expect(
      getModelControls({ provider: "anthropic", model: "claude-haiku-4-5" })
        .thinkingNeedsEffort,
    ).toBe(false);
  });

  it("offers OpenAI priority only for models that support it", () => {
    expect(
      getModelControls({ provider: "openai", model: "gpt-5.5" }).fast,
    ).toBe(true);
    expect(getModelControls({ provider: "openai", model: "gpt-4o" }).fast).toBe(
      true,
    );
    expect(
      getModelControls({ provider: "openai", model: "gpt-3.5-turbo" }).fast,
    ).toBe(false);
  });

  it("keeps priority for gpt-4o and gpt-4.1 snapshots", () => {
    // The catalog lists priority only on the undated ids
    for (const model of [
      "gpt-4o-2024-08-06",
      "gpt-4o-2024-11-20",
      "gpt-4.1-2025-04-14",
    ]) {
      expect(getModelControls({ provider: "openai", model }).fast, model).toBe(
        true,
      );
    }
  });

  it("offers the input limit as the largest context, not the whole window", () => {
    // GPT-5.5: a 1,050,000-token window, at most 922,000 tokens of input
    expect(
      getModelControls({ provider: "openai", model: "gpt-5.5" })
        .maxContextLength,
    ).toBe(922_000);
  });

  it("uses Claude's own levels on OpenRouter and has no fast mode", () => {
    expect(
      getModelControls({
        provider: "openrouter",
        model: "anthropic/claude-opus-5-5",
      }),
    ).toMatchObject({
      efforts: ["low", "medium", "high", "xhigh", "max"],
      fast: false,
      experimental: false,
    });
    expect(
      getModelControls({ provider: "openrouter", model: "qwen/qwen3-max" }),
    ).toMatchObject({
      efforts: ["low", "medium", "high"],
      fast: false,
      experimental: true,
    });
  });

  it("marks Claude 4.6 to 4.8 thinking on OpenRouter as needing an effort", () => {
    const needsEffort = (model: string) =>
      getModelControls({ provider: "openrouter", model }).thinkingNeedsEffort;
    expect(needsEffort("anthropic/claude-sonnet-4.6")).toBe(true);
    expect(needsEffort("anthropic/claude-sonnet-4-6")).toBe(true);
    expect(needsEffort("anthropic/claude-opus-4.8")).toBe(true);
    expect(needsEffort("anthropic/claude-opus-5-5")).toBe(false);
    expect(needsEffort("anthropic/claude-haiku-4.5")).toBe(false);
    expect(needsEffort("deepseek/deepseek-v4-pro")).toBe(false);
  });

  it("offers OpenAI effort only for reasoning models", () => {
    expect(
      getModelControls({ provider: "openai", model: "gpt-5.5" }).efforts,
    ).toEqual(["low", "medium", "high", "xhigh"]);
    expect(
      getModelControls({ provider: "openai", model: "gpt-4.1" }).efforts,
    ).toEqual([]);
  });

  it("marks gateway levels as experimental", () => {
    expect(
      getModelControls({ provider: "oneprovider", model: "deepseek-v4-pro" }),
    ).toMatchObject({ format: "deepseek", experimental: false });
  });
});

describe("Claude thinking off", () => {
  it("doesn't offer Off for Opus 5.5, which always thinks", () => {
    for (const provider of ["anthropic", "oneprovider"]) {
      const controls = getModelControls({ provider, model: "claude-opus-5-5" });
      expect(controls.thinkingModes).toEqual(["hidden", "shown"]);
      expect(controls.thinkingUnavailable.off).toBeDefined();
    }
  });

  it("doesn't offer Off for Fable 5.x either", () => {
    for (const model of ["claude-fable-5-1", "claude-fable-5"]) {
      expect(
        getModelControls({ provider: "anthropic", model }).thinkingModes,
      ).toEqual(["hidden", "shown"]);
    }
  });

  it("still offers Off for Sonnet 5.5", () => {
    expect(
      getModelControls({ provider: "anthropic", model: "claude-sonnet-5-5" })
        .thinkingModes,
    ).toContain("off");
  });
});

describe("buildModelControlFields", () => {
  it("writes Anthropic controls for the adapter", () => {
    expect(
      buildModelControlFields(
        { provider: "anthropic", model: "claude-opus-5-5" },
        { effort: "high", showThinking: true, fast: true },
      ),
    ).toEqual({
      reasoning_effort: "high",
      nextcli_show_thinking: true,
      nextcli_fast: true,
    });
  });

  it("uses reasoning_effort and service_tier for OpenAI", () => {
    expect(
      buildModelControlFields(
        { provider: "openai", model: "gpt-5.5" },
        { effort: "low", fast: true },
      ),
    ).toEqual({ reasoning_effort: "low", service_tier: "priority" });
  });

  it("never sends priority to models without it", () => {
    expect(
      buildModelControlFields(
        { provider: "openai", model: "gpt-3.5-turbo" },
        { fast: true },
      ),
    ).toEqual({});
  });

  it("clamps a level the model lacks to the nearest one", () => {
    expect(
      buildModelControlFields(
        { provider: "anthropic", model: "claude-sonnet-4-6" },
        { effort: "xhigh" },
      ),
    ).toEqual({ reasoning_effort: "high" });
    expect(
      buildModelControlFields(
        { provider: "openrouter", model: "qwen/qwen3-max" },
        { effort: "minimal" },
      ),
    ).toEqual({ reasoning_effort: "low" });
  });

  it("turns DeepSeek thinking off", () => {
    expect(
      buildModelControlFields(
        { provider: "deepseek", model: "deepseek-v4-pro" },
        { effort: "off" },
      ),
    ).toEqual({ thinking: { type: "disabled" } });
  });

  it("ignores settings the model doesn't support", () => {
    expect(
      buildModelControlFields(
        { provider: "anthropic", model: "claude-sonnet-5-5" },
        { effort: "turbo", fast: true },
      ),
    ).toEqual({});
    expect(
      buildModelControlFields(
        { provider: "openai", model: "gpt-4.1" },
        { effort: "high" },
      ),
    ).toEqual({});
  });
});

describe("clampEffort", () => {
  it("keeps supported levels and steps down to the nearest one", () => {
    expect(clampEffort(["low", "medium", "high"], "medium")).toBe("medium");
    expect(clampEffort(["low", "medium", "high"], "max")).toBe("high");
    expect(clampEffort(["low", "medium", "high"], "minimal")).toBe("low");
  });

  it("uses off and unknown levels only when listed", () => {
    expect(clampEffort(["off"], "off")).toBe("off");
    expect(clampEffort(["low", "high"], "off")).toBeUndefined();
    expect(clampEffort(["low", "high"], "turbo")).toBeUndefined();
    expect(clampEffort([], "high")).toBeUndefined();
  });
});

describe("thinking modes", () => {
  const modes = (provider: string, model: string) =>
    getModelControls({ provider, model }).thinkingModes;

  it("offers Off where the provider can turn thinking off", () => {
    expect(modes("anthropic", "claude-sonnet-5-5")).toEqual([
      "off",
      "hidden",
      "shown",
    ]);
    expect(modes("deepseek", "deepseek-v4-pro")).toEqual([
      "off",
      "hidden",
      "shown",
    ]);
    expect(modes("openrouter", "qwen/qwen3-max")).toEqual([
      "off",
      "hidden",
      "shown",
    ]);
    expect(modes("gemini", "gemini-3.1-flash-lite")).toEqual([
      "off",
      "hidden",
      "shown",
    ]);
    expect(modes("gemini", "gemini-2.5-flash")).toEqual([
      "off",
      "hidden",
      "shown",
    ]);
    expect(modes("openai", "gpt-5.5")).toEqual(["off", "hidden", "shown"]);
  });

  it("explains why Off is missing", () => {
    const pro = getModelControls({
      provider: "gemini",
      model: "gemini-3.1-pro",
    });
    expect(pro.thinkingModes).toEqual(["hidden", "shown"]);
    expect(pro.thinkingUnavailable.off).toMatch(/always think/);
    expect(
      getModelControls({ provider: "openai", model: "gpt-5" }).thinkingModes,
    ).toEqual(["hidden", "shown"]);
    expect(
      getModelControls({ provider: "moonshot", model: "kimi-k2-thinking" })
        .thinkingUnavailable.off,
    ).toBeDefined();
    expect(
      getModelControls({ provider: "xAI", model: "grok-4.20-0309-reasoning" })
        .thinkingUnavailable.off,
    ).toMatch(/always reasons/);
  });

  it("has no thinking row for models that don't think", () => {
    expect(modes("openai", "gpt-4.1")).toEqual([]);
    expect(modes("gemini", "gemini-2.0-flash")).toEqual([]);
    expect(modes("xAI", "grok-4-fast-non-reasoning")).toEqual([]);
    expect(modes("anthropic", "my-custom-model")).toEqual([]);
  });

  it("knows each model's default", () => {
    const def = (provider: string, model: string) =>
      getModelControls({ provider, model }).defaultThinking;
    expect(def("anthropic", "claude-opus-5-5")).toBe("shown");
    expect(def("anthropic", "claude-sonnet-4-6")).toBe("off");
    expect(def("openai", "gpt-5.5")).toBe("hidden");
    expect(def("gemini", "gemini-3.1-pro")).toBe("shown");
  });
});

describe("Gemini and Bedrock controls", () => {
  it("uses the catalog's thinking levels on Gemini 3 and budgets on 2.5", () => {
    // gemini-3.1-pro is listed as gemini-3.1-pro-preview
    expect(
      getModelControls({ provider: "gemini", model: "gemini-3.1-pro" }),
    ).toMatchObject({
      format: "gemini",
      efforts: ["low", "medium", "high"],
      effortNeedsThinking: true,
      fast: false,
      maxContextLength: 1_048_576,
      experimental: false,
    });
    expect(
      getModelControls({ provider: "gemini", model: "gemini-3.8-flash" }),
    ).toMatchObject({
      efforts: ["low", "medium", "high"],
      experimental: false,
    });
    // Not in the catalog: low and high, which every thinking level takes
    expect(
      getModelControls({ provider: "gemini", model: "gemini-9-flash" }),
    ).toMatchObject({ efforts: ["low", "high"], experimental: true });
    expect(
      getModelControls({ provider: "gemini", model: "gemini-2.5-flash" })
        .efforts,
    ).toEqual(["low", "medium", "high"]);
  });

  it("parses Gemini versions and tiers", () => {
    expect(parseGeminiModelVersion("gemini-3.5-flash-lite")).toEqual({
      major: 3,
      minor: 5,
      tier: "flash-lite",
    });
    expect(parseGeminiModelVersion("models/gemini-4-argon")).toEqual({
      major: 4,
      minor: 0,
      tier: "other",
    });
    expect(parseGeminiModelVersion("gpt-5")).toBeUndefined();
  });

  it("uses Claude's rules on Bedrock without fast mode", () => {
    expect(
      getModelControls({
        provider: "bedrock",
        model: "us.anthropic.claude-opus-5-5-v1:0",
      }),
    ).toMatchObject({
      format: "bedrock",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      thinkingModes: ["hidden", "shown"],
      fast: false,
    });
    expect(
      getModelControls({ provider: "bedrock", model: "amazon.nova-pro-v1:0" })
        .thinkingModes,
    ).toEqual([]);
  });
});

describe("chosen and effective thinking mode", () => {
  // A Claude 5 model that thinks by default and can still turn it off
  const opus = getModelControls({
    provider: "anthropic",
    model: "claude-sonnet-5-5",
  });
  const sonnet46 = getModelControls({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  });
  const gemini = getModelControls({
    provider: "gemini",
    model: "gemini-3.1-pro",
  });
  const deepseek = getModelControls({
    provider: "deepseek",
    model: "deepseek-v4-pro",
  });

  it("prefers the chosen mode, then the older settings", () => {
    expect(chosenThinkingMode(opus, { thinking: "off" })).toBe("off");
    expect(chosenThinkingMode(opus, { showThinking: false })).toBe("hidden");
    expect(
      chosenThinkingMode(opus, { thinking: "shown", showThinking: false }),
    ).toBe("shown");
    expect(chosenThinkingMode(deepseek, { effort: "off" })).toBe("off");
    expect(chosenThinkingMode(opus, {})).toBeUndefined();
  });

  it("ignores a mode the model lacks", () => {
    expect(chosenThinkingMode(gemini, { thinking: "off" })).toBeUndefined();
    expect(effectiveThinkingMode(gemini, { thinking: "off" })).toBe("shown");
  });

  it("turns thinking on when an effort is set on Claude 4.x", () => {
    expect(effectiveThinkingMode(sonnet46, {})).toBe("off");
    expect(effectiveThinkingMode(sonnet46, { effort: "high" })).toBe("shown");
    expect(effectiveThinkingMode(opus, {})).toBe("shown");
  });
});

describe("buildModelControlFields thinking modes", () => {
  it("sends the chosen Claude mode for the adapter", () => {
    expect(
      buildModelControlFields(
        { provider: "anthropic", model: "claude-sonnet-5-5" },
        { thinking: "off", effort: "low" },
      ),
    ).toEqual({ reasoning_effort: "low", nextcli_thinking: "off" });
    expect(
      buildModelControlFields(
        { provider: "bedrock", model: "anthropic.claude-opus-5-5" },
        { thinking: "hidden", fast: true },
      ),
    ).toEqual({ nextcli_thinking: "hidden" });
  });

  it("uses effort none to turn OpenAI reasoning off", () => {
    expect(
      buildModelControlFields(
        { provider: "openai", model: "gpt-5.5" },
        { thinking: "off", effort: "high" },
      ),
    ).toEqual({ reasoning_effort: "none" });
    expect(
      buildModelControlFields(
        { provider: "openai", model: "gpt-5.5" },
        { thinking: "shown", effort: "high" },
      ),
    ).toEqual({ reasoning_effort: "high", nextcli_show_thinking: true });
    // GPT-5 can't turn reasoning off, so the choice is ignored
    expect(
      buildModelControlFields(
        { provider: "openai", model: "gpt-5" },
        { thinking: "off" },
      ),
    ).toEqual({});
  });

  it("drops the effort while thinking is off where it needs thinking", () => {
    expect(
      buildModelControlFields(
        { provider: "openrouter", model: "qwen/qwen3-max" },
        { thinking: "off", effort: "high" },
      ),
    ).toEqual({ nextcli_thinking: "off", nextcli_show_thinking: false });
    expect(
      buildModelControlFields(
        { provider: "openrouter", model: "anthropic/claude-haiku-5.5" },
        { thinking: "shown" },
      ),
    ).toEqual({ nextcli_thinking: "shown", nextcli_show_thinking: true });
    // The older show thinking flag alone keeps requests as they were
    expect(
      buildModelControlFields(
        { provider: "openrouter", model: "anthropic/claude-haiku-5.5" },
        { showThinking: true },
      ),
    ).toEqual({ nextcli_show_thinking: true });
  });

  it("writes Gemini and DeepSeek modes", () => {
    expect(
      buildModelControlFields(
        { provider: "gemini", model: "gemini-3.8-flash" },
        { thinking: "shown", effort: "low" },
      ),
    ).toEqual({ reasoning_effort: "low", nextcli_thinking: "shown" });
    // Gemini 3+ Flash must reason, so Off is ignored
    expect(
      buildModelControlFields(
        { provider: "gemini", model: "gemini-3.5-flash" },
        { thinking: "off" },
      ),
    ).toEqual({});
    expect(
      buildModelControlFields(
        { provider: "deepseek", model: "deepseek-v4-pro" },
        { thinking: "off" },
      ),
    ).toEqual({ thinking: { type: "disabled" } });
  });
});

describe("context options", () => {
  it("offers standard steps up to the model's limit", () => {
    expect(getContextOptions(1_000_000, 128_000)).toEqual([
      64_000, 128_000, 200_000, 256_000, 400_000, 1_000_000,
    ]);
    expect(getContextOptions(undefined, 32_000)).toEqual([32_000]);
    expect(getContextOptions(200_000, 300_000)).toEqual([
      64_000, 128_000, 200_000, 256_000, 300_000,
    ]);
    // A configured window between the steps is offered too, so the current
    // choice is one of the options
    expect(getContextOptions(131_072, 8_192)).toEqual([
      8_192, 64_000, 128_000, 131_072,
    ]);
    expect(getContextOptions(1_000_000, 150_000)).toEqual([
      64_000, 128_000, 150_000, 200_000, 256_000, 400_000, 1_000_000,
    ]);
  });

  it("formats context lengths", () => {
    expect(formatContextLength(200_000)).toBe("200K");
    expect(formatContextLength(1_000_000)).toBe("1M");
    expect(formatContextLength(1_048_576)).toBe("1.05M");
  });
});

describe("DeepSeek", () => {
  it("has thinking modes, no effort and the catalog's context window", () => {
    // The catalog lists low, high and max; catalogOverrides.ts keeps them out
    // until they are checked
    expect(
      getModelControls({ provider: "deepseek", model: "deepseek-v4-pro" }),
    ).toMatchObject({
      efforts: [],
      thinkingModes: ["off", "hidden", "shown"],
      fast: false,
      maxContextLength: 1_048_576,
    });
    expect(getContextOptions(1_000_000, 64_000)).toEqual([
      64_000, 128_000, 200_000, 256_000, 400_000, 1_000_000,
    ]);
    // A larger configured window is still offered
    expect(getContextOptions(1_000_000, 1_000_000).at(-1)).toBe(1_000_000);
  });

  it("reads V4 Flash's context from the catalog, and none for unlisted models", () => {
    expect(
      getModelControls({ provider: "deepseek", model: "deepseek-v4-flash" })
        .maxContextLength,
    ).toBe(1_048_576);
    // Not in the catalog: the configured context length is offered instead
    expect(
      getModelControls({ provider: "deepseek", model: "deepseek-v4.1-flash" })
        .maxContextLength,
    ).toBeUndefined();
  });

  it("routes OneProvider DeepSeek through the deepseek case", () => {
    expect(
      getModelControls({ provider: "oneprovider", model: "deepseek-v4-pro" }),
    ).toMatchObject({
      format: "deepseek",
      maxContextLength: 1_048_576,
    });
  });

  it("sends nothing for Hidden and Shown", () => {
    for (const thinking of ["hidden", "shown"] as const) {
      expect(
        buildModelControlFields(
          { provider: "deepseek", model: "deepseek-v4-pro" },
          { thinking },
        ),
      ).toEqual({});
    }
  });
});

// Checked against the live Kimi API on 2026-11-04
describe("Kimi", () => {
  it("offers thinking off, low to max effort and 1M context on Kimi K3", () => {
    for (const model of [
      "kimi-k3",
      "kimi-k3.1-pro",
      "kimi-k3.1-pro-highspeed",
    ]) {
      expect(getModelControls({ provider: "moonshot", model })).toMatchObject({
        efforts: ["low", "high", "max"],
        thinkingModes: ["off", "hidden", "shown"],
        effortNeedsThinking: true,
        fast: false,
        maxContextLength: 1_048_576,
        experimental: false,
      });
    }
  });

  it("keeps thinking on for -thinking models and hides it for others", () => {
    expect(
      getModelControls({ provider: "moonshot", model: "kimi-k2-thinking" })
        .thinkingModes,
    ).toEqual(["hidden", "shown"]);
    for (const model of ["kimi-k2-instruct"]) {
      expect(
        getModelControls({ provider: "moonshot", model }).thinkingModes,
      ).toEqual([]);
    }
  });

  it("sends disabled thinking for Off and the effort otherwise", () => {
    const kimi = { provider: "moonshot", model: "kimi-k3.1-pro" };
    expect(
      buildModelControlFields(kimi, { thinking: "off", effort: "high" }),
    ).toEqual({ thinking: { type: "disabled" } });
    expect(buildModelControlFields(kimi, { effort: "low" })).toEqual({
      reasoning_effort: "low",
    });
    // Medium isn't a Kimi level, so it steps down to low
    expect(buildModelControlFields(kimi, { effort: "medium" })).toEqual({
      reasoning_effort: "low",
    });
    expect(buildModelControlFields(kimi, { thinking: "hidden" })).toEqual({});
  });
});

// Checked against the live APIs on 2026-11-04
describe("OpenAI levels per model", () => {
  it("matches the levels each model accepts", () => {
    const levels = (model: string) =>
      getModelControls({ provider: "openai", model });
    expect(levels("gpt-5")).toMatchObject({
      efforts: ["minimal", "low", "medium", "high"],
      thinkingModes: ["hidden", "shown"],
    });
    expect(levels("gpt-5-mini").efforts).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(levels("gpt-5.1")).toMatchObject({
      efforts: ["low", "medium", "high"],
      thinkingModes: ["off", "hidden", "shown"],
    });
    expect(levels("gpt-5.4-mini").efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(levels("gpt-5.6-sol").efforts.at(-1)).toBe("max");
    expect(levels("gpt-6-sol").thinkingModes).toContain("off");
    expect(levels("gpt-6.1-sol")).toMatchObject({
      efforts: ["low", "medium", "high", "xhigh", "max"],
      thinkingModes: ["hidden", "shown"],
      experimental: false,
    });
    expect(levels("o3")).toMatchObject({
      efforts: ["low", "medium", "high"],
      thinkingModes: ["hidden", "shown"],
    });
    expect(levels("gpt-7").experimental).toBe(true);
  });

  it("never sends minimal to models that reject it", () => {
    expect(
      buildModelControlFields(
        { provider: "openai", model: "gpt-5.5" },
        { effort: "minimal" },
      ),
    ).toEqual({ reasoning_effort: "low" });
  });
});

describe("xAI levels per model", () => {
  const grok = (model: string) => getModelControls({ provider: "xAI", model });

  it("offers effort and Off where the API takes them", () => {
    expect(grok("grok-4.3")).toMatchObject({
      efforts: ["minimal", "low", "medium", "high", "xhigh"],
      thinkingModes: ["off", "hidden", "shown"],
      experimental: false,
    });
    expect(grok("grok-4.7")).toMatchObject({
      efforts: ["minimal", "low", "medium", "high", "xhigh"],
      thinkingModes: ["hidden", "shown"],
    });
  });

  it("has no effort for models that reject it", () => {
    expect(grok("grok-4.20-0309-reasoning")).toMatchObject({
      format: "xai",
      efforts: [],
      thinkingModes: ["hidden", "shown"],
      experimental: false,
    });
    expect(grok("grok-4.20-0309-non-reasoning").thinkingModes).toEqual([]);
  });

  it("sends none only to grok-4.3", () => {
    expect(
      buildModelControlFields(
        { provider: "xAI", model: "grok-4.3" },
        { thinking: "off" },
      ),
    ).toEqual({ reasoning_effort: "none" });
    // Later models reject none, so Off isn't offered or sent
    expect(
      buildModelControlFields(
        { provider: "xAI", model: "grok-4.7" },
        { thinking: "off" },
      ),
    ).toEqual({});
    expect(
      buildModelControlFields(
        { provider: "xAI", model: "grok-4.7" },
        { effort: "high" },
      ),
    ).toEqual({ reasoning_effort: "high" });
  });
});

describe("OpenRouter thinking off per vendor", () => {
  const modes = (model: string) =>
    getModelControls({ provider: "openrouter", model }).thinkingModes;

  it("offers Off where OpenRouter accepts it", () => {
    for (const model of [
      "anthropic/claude-haiku-5.5",
      "deepseek/deepseek-v4-pro",
      "moonshotai/kimi-k3.1-pro",
      "qwen/qwen3.8-flash",
      "openai/gpt-5.5",
      "google/gemini-3.1-flash-lite",
    ]) {
      expect(modes(model)).toEqual(["off", "hidden", "shown"]);
    }
  });

  it("leaves Off out where reasoning is mandatory", () => {
    for (const model of [
      "google/gemini-3.5-flash",
      "google/gemini-3.1-pro-preview",
      "x-ai/grok-4.7",
    ]) {
      expect(modes(model)).toEqual(["hidden", "shown"]);
    }
  });
});

describe("generic providers", () => {
  const generic = (model: string, reasoningConfigured?: boolean) =>
    getModelControls({ provider: "mistral", model, reasoningConfigured });

  it("offers reasoning rows only for reasoning models", () => {
    expect(generic("codestral-latest").efforts).toEqual([]);
    expect(generic("codestral-latest").thinkingModes).toEqual([]);
    // The catalog marks Mistral Large as reasoning, with its levels
    expect(generic("mistral-large-latest")).toMatchObject({
      efforts: ["low", "medium", "high"],
      thinkingModes: ["hidden", "shown"],
      maxContextLength: 1_048_576,
      experimental: false,
    });
    expect(generic("phi-4-reasoning").efforts).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(generic("qwen3.8-max").thinkingModes).toEqual(["hidden", "shown"]);
    // models.dev lists every Qwen3-Coder as non-reasoning
    expect(generic("qwen3-coder-30b").thinkingModes).toEqual([]);
  });

  it("recognises current reasoning families but not retired ones", () => {
    for (const model of [
      "deepseek-v4-pro",
      "claude-sonnet-4-5",
      "grok-4.7",
      "gemini-2.5-pro",
      "o3",
      // Open-weight, still hosted by third parties
      "deepseek-v3.2",
      // Qwen 3 and later are hybrid reasoning models
      "qwen3.8-max",
      "qwen4-max-preview",
      "qwen3-vl-plus",
    ]) {
      expect(looksLikeReasoningModel(model)).toBe(true);
    }
    for (const model of [
      "grok-3",
      "claude-3-7-sonnet",
      "deepseek-v3",
      "qwen-max",
      "qwen2.5-72b-instruct",
      // Qwen's Coder and Instruct models don't think
      "qwen3-coder-plus",
      "qwen3-next-80b-a3b-instruct",
      "qwen4-vl-instruct",
    ]) {
      expect(looksLikeReasoningModel(model)).toBe(false);
    }
  });

  it("trusts a config that marks the model as reasoning", () => {
    expect(generic("my-finetune", true).efforts).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("Azure OpenAI", () => {
  it("uses OpenAI levels without readable reasoning or fast mode", () => {
    expect(
      getModelControls({ provider: "azure", model: "gpt-5.5" }),
    ).toMatchObject({
      format: "azure",
      efforts: ["low", "medium", "high", "xhigh"],
      thinkingModes: ["off", "hidden"],
      fast: false,
    });
    expect(
      getModelControls({ provider: "azure", model: "gpt-4o" }).efforts,
    ).toEqual([]);
  });

  it("sends reasoning_effort for Chat Completions", () => {
    expect(
      buildModelControlFields(
        { provider: "azure", model: "gpt-5.5" },
        { thinking: "off" },
      ),
    ).toEqual({ reasoning_effort: "none" });
    expect(
      buildModelControlFields(
        { provider: "azure", model: "gpt-5.5" },
        { effort: "high" },
      ),
    ).toEqual({ reasoning_effort: "high" });
  });
});

// OpenRouter accepts every effort level and maps it (checked 2026-11-04)
describe("OpenRouter effort levels per vendor", () => {
  const efforts = (model: string) =>
    getModelControls({ provider: "openrouter", model });

  it("lists the vendor's own levels", () => {
    expect(efforts("google/gemini-3.1-pro-preview").efforts).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(efforts("moonshotai/kimi-k3.1-pro")).toMatchObject({
      efforts: ["low", "high", "max"],
      experimental: false,
    });
    expect(efforts("openai/gpt-5.5").efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(efforts("x-ai/grok-4.7").efforts).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("falls back to low, medium and high for other vendors", () => {
    expect(efforts("qwen/qwen3.8-flash")).toMatchObject({
      efforts: ["low", "medium", "high"],
      experimental: true,
    });
  });

  it("never sends a level the vendor lacks", () => {
    expect(
      buildModelControlFields(
        { provider: "openrouter", model: "moonshotai/kimi-k3.1-pro" },
        { effort: "medium" },
      ),
    ).toEqual({ reasoning_effort: "low" });
  });
});

describe("catalog-backed controls", () => {
  it("fixes OpenAI models the version rules missed", () => {
    expect(
      getModelControls({ provider: "openai", model: "o4-mini" }),
    ).toMatchObject({
      efforts: ["low", "medium", "high"],
      thinkingModes: ["hidden", "shown"],
      experimental: false,
    });
    expect(
      getModelControls({ provider: "openai", model: "gpt-5-pro" }).efforts,
    ).toEqual(["high"]);
  });

  it("gives unlisted models conservative levels, marked experimental", () => {
    expect(
      getModelControls({ provider: "openai", model: "gpt-7" }),
    ).toMatchObject({
      efforts: ["low", "medium", "high"],
      thinkingModes: ["hidden", "shown"],
      fast: false,
      experimental: true,
    });
    expect(
      getModelControls({ provider: "openai", model: "gpt-7" }),
    ).not.toHaveProperty("maxContextLength", expect.any(Number));
  });

  it("reads OneProvider's non-Claude models from their vendor's catalog", () => {
    expect(
      getModelControls({ provider: "oneprovider", model: "gpt-5.5" }),
    ).toMatchObject({
      format: "generic",
      efforts: ["low", "medium", "high", "xhigh"],
      // The input limit, not the 1,050,000-token window
      maxContextLength: 922_000,
      experimental: false,
    });
  });

  it('offers no "default" level, and guesses none for a model that lists only it', () => {
    const groq = (model: string) =>
      getModelControls({ provider: "groq", model });
    // The catalog lists ["none", "default", "low", "medium", "high"]
    expect(groq("qwen/qwen3.8-27b")).toMatchObject({
      format: "generic",
      efforts: ["low", "medium", "high"],
      experimental: false,
    });
    // ["none", "default"]: Groq rejects any other level for it
    expect(groq("qwen/qwen3.6-27b")).toMatchObject({
      format: "generic",
      efforts: [],
      experimental: false,
    });
  });

  it("keeps thinking on for OneProvider's -thinking ids", () => {
    const controls = getModelControls({
      provider: "oneprovider",
      model: "claude-sonnet-5-5-thinking",
    });
    expect(controls.thinkingModes).toEqual(["hidden", "shown"]);
    expect(controls.thinkingUnavailable.off).toContain("-thinking");
    expect(controls.maxContextLength).toBe(1_000_000);
  });

  it("applies no tables to a custom OpenAI-compatible endpoint", () => {
    expect(
      getModelControls({
        provider: "openai",
        model: "gpt-5.5",
        apiBase: "http://127.0.0.1:8091/v1",
      }),
    ).toMatchObject({
      format: "generic",
      efforts: ["low", "medium", "high"],
      experimental: true,
    });
    expect(
      getModelControls({
        provider: "openai",
        model: "gpt-5.5",
        apiBase: "http://127.0.0.1:8091/v1",
      }).maxContextLength,
    ).toBeUndefined();
  });
});

describe("catalog corrections that change what is sent", () => {
  it("keeps Off away from gpt-6.1, whose API rejects reasoning_effort none", () => {
    // The catalog lists none for gpt-6.1-terra; the live check on
    // 2026-11-04 found gpt-6.1 rejects it, so Off would be a 400
    expect(CATALOG.openai["gpt-6.1-terra"].efforts).toContain("none");
    for (const model of ["gpt-6.1-terra", "gpt-6.1-sol"]) {
      const controls = getModelControls({ provider: "openai", model });
      expect(controls.thinkingModes, model).not.toContain("off");
      expect(
        buildModelControlFields(
          { provider: "openai", model },
          { thinking: "off" },
        ),
        model,
      ).not.toHaveProperty("reasoning_effort", "none");
    }
    // gpt-6-astra: the catalog has no none, so no Off either
    expect(
      getModelControls({ provider: "openai", model: "gpt-6-astra" })
        .thinkingModes,
    ).not.toContain("off");
  });

  it("gives OpenAI-style effort controls on Azure only to OpenAI's models", () => {
    for (const model of ["claude-fable-5", "deepseek-v4-flash"]) {
      const controls = getModelControls({ provider: "azure", model });
      expect(controls.efforts, model).toEqual([]);
      expect(controls.thinkingModes, model).toEqual([]);
      expect(
        buildModelControlFields(
          { provider: "azure", model },
          { effort: "high", thinking: "off" },
        ),
        model,
      ).not.toHaveProperty("reasoning_effort");
    }
    expect(
      getModelControls({ provider: "azure", model: "gpt-5.5" }).efforts,
    ).toContain("high");
  });

  it("agrees with the request code on Claude's effort levels", () => {
    // The menu reads the catalog; the Anthropic request code clamps with
    // anthropicEffortLevels. A sync that moves one must move the other.
    for (const provider of ["anthropic", "amazon-bedrock"]) {
      for (const [id, model] of Object.entries(CATALOG[provider])) {
        if (!id.includes("claude")) continue;
        const name = id.replace(/^.*?anthropic\./, "");
        expect(
          (model.efforts ?? []).filter((effort) => effort !== "none"),
          `${provider} ${id}`,
        ).toEqual(anthropicEffortLevels(name));
      }
    }
  });
});
