import { describe, expect, it } from "vitest";

import {
  buildModelControlFields,
  clampEffort,
  getControlsFormat,
  getModelControls,
} from "./modelControls.js";

describe("getControlsFormat", () => {
  it("follows the adapter the request goes through", () => {
    expect(
      getControlsFormat({ provider: "anthropic", model: "claude-opus-5-5" }),
    ).toBe("anthropic");
    expect(getControlsFormat({ provider: "openai", model: "gpt-5.5" })).toBe(
      "openai",
    );
    expect(
      getControlsFormat({
        provider: "openai",
        model: "deepseek-v4-pro",
        apiBase: "https://api.oneprovider.dev/v1",
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

describe("getModelControls", () => {
  it("lists Claude effort levels, fast mode and context per model", () => {
    expect(
      getModelControls({ provider: "anthropic", model: "claude-opus-5-5" }),
    ).toEqual({
      format: "anthropic",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      canShowThinking: true,
      thinkingNeedsEffort: false,
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
    ).toEqual(["minimal", "low", "medium", "high"]);
    expect(
      getModelControls({ provider: "openai", model: "gpt-4.1" }).efforts,
    ).toEqual([]);
  });

  it("marks gateway levels as experimental", () => {
    expect(
      getModelControls({ provider: "oneprovider", model: "deepseek-v4-pro" }),
    ).toMatchObject({ format: "generic", experimental: true });
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
