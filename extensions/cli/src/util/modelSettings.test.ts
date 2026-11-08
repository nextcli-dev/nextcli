import type { ModelConfig } from "@nextcli/config-yaml";
import { beforeEach, describe, expect, it } from "vitest";

import { getCompletionOptions } from "../stream/streamChatResponse.types.js";

import {
  effectiveEffort,
  effectiveThinking,
  getContextOptions,
  getModelSettings,
  modelStatusLabel,
  resetModelSettingsCache,
  setSessionEffort,
  shouldShowReasoning,
  updateModelSettings,
} from "./modelSettings.js";
import { getModelContextLimit } from "./tokenizer.js";

function model(partial: Partial<ModelConfig>): ModelConfig {
  return {
    name: partial.model,
    roles: ["chat"],
    ...partial,
  } as ModelConfig;
}

const opus = model({ provider: "anthropic", model: "claude-opus-5-5" });
const gpt = model({ provider: "openai", model: "gpt-5.5" });

describe("model settings", () => {
  beforeEach(() => {
    resetModelSettingsCache();
    updateModelSettings(opus, {
      effort: undefined,
      fast: undefined,
      showThinking: undefined,
      contextLength: undefined,
    });
    updateModelSettings(gpt, { effort: undefined, fast: undefined });
    resetModelSettingsCache();
  });

  it("shows thinking by default and has no effort", () => {
    expect(getModelSettings(opus)).toMatchObject({
      showThinking: true,
      effort: undefined,
    });
  });

  it("leaves readable thinking off by default on OpenAI", () => {
    // Reasoning summaries need a verified organization
    expect(getModelSettings(gpt).showThinking).toBe(false);
    updateModelSettings(gpt, { showThinking: true });
    expect(getModelSettings(gpt).showThinking).toBe(true);
    updateModelSettings(gpt, { showThinking: undefined });
  });

  it("saves settings per model", () => {
    updateModelSettings(opus, { effort: "xhigh", fast: true });
    resetModelSettingsCache();
    expect(getModelSettings(opus)).toMatchObject({
      effort: "xhigh",
      fast: true,
    });
    expect(getModelSettings(gpt).effort).toBeUndefined();
  });

  it("uses --effort, then the menu, then the config", () => {
    const configured = model({
      provider: "anthropic",
      model: "claude-opus-5-5",
      defaultCompletionOptions: { reasoningEffort: "low" },
    });
    expect(getModelSettings(configured).effort).toBe("low");
    updateModelSettings(configured, { effort: "high" });
    expect(getModelSettings(configured).effort).toBe("high");
    setSessionEffort("max");
    expect(getModelSettings(configured).effort).toBe("max");
  });

  it("treats reasoning: true in the config as medium effort", () => {
    const configured = model({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      defaultCompletionOptions: { reasoning: true },
    });
    expect(getModelSettings(configured).effort).toBe("medium");
  });

  it("offers context windows up to the model's maximum", () => {
    expect(getContextOptions(opus, 200_000)).toEqual([
      64_000, 128_000, 200_000, 256_000, 400_000, 1_000_000,
    ]);
    expect(getContextOptions(gpt, 200_000)).toEqual([64_000, 128_000, 200_000]);
  });

  it("uses the chosen context window for compaction limits", () => {
    expect(getModelContextLimit(opus)).toBe(200_000);
    updateModelSettings(opus, { contextLength: 1_000_000 });
    expect(getModelContextLimit(opus)).toBe(1_000_000);
  });

  it("labels the model with its effort and fast mode", () => {
    updateModelSettings(opus, { effort: "high", fast: true });
    expect(modelStatusLabel(opus)).toBe("claude-opus-5-5 · High · Fast");
  });

  it("shows the level actually sent when the model lacks the chosen one", () => {
    const sonnet = model({ provider: "anthropic", model: "claude-sonnet-4-6" });
    setSessionEffort("xhigh");
    expect(effectiveEffort(sonnet)).toBe("high");
    expect(modelStatusLabel(sonnet)).toBe("claude-sonnet-4-6 · High");
  });
});

describe("getCompletionOptions", () => {
  beforeEach(() => {
    resetModelSettingsCache();
    updateModelSettings(opus, { effort: "high", fast: true });
    updateModelSettings(gpt, { effort: "low", fast: true });
  });

  it("adds Anthropic controls and top_k for Claude", () => {
    const options = getCompletionOptions({
      ...opus,
      defaultCompletionOptions: { topK: 40, maxTokens: 4000 },
    } as ModelConfig);
    expect(options).toMatchObject({
      max_tokens: 4000,
      top_k: 40,
      reasoning_effort: "high",
      nextcli_fast: true,
      nextcli_show_thinking: true,
    });
  });

  it("uses OpenAI fields and never top_k for OpenAI", () => {
    const options = getCompletionOptions({
      ...gpt,
      defaultCompletionOptions: { topK: 40 },
    } as ModelConfig) as Record<string, unknown>;
    expect(options).toMatchObject({
      reasoning_effort: "low",
      service_tier: "priority",
    });
    expect(options).not.toHaveProperty("top_k");
    // No reasoning summary unless the user turns Show thinking on
    expect(options.nextcli_show_thinking).not.toBe(true);
  });
});

describe("thinking mode", () => {
  const sonnet46 = model({ provider: "anthropic", model: "claude-sonnet-4-6" });

  beforeEach(() => {
    resetModelSettingsCache();
    for (const m of [opus, gpt, sonnet46]) {
      updateModelSettings(m, {
        effort: undefined,
        fast: undefined,
        showThinking: undefined,
        thinking: undefined,
      });
    }
  });

  it("follows each model's default until a mode is chosen", () => {
    expect(effectiveThinking(opus)).toBe("shown");
    expect(effectiveThinking(gpt)).toBe("hidden");
    expect(effectiveThinking(sonnet46)).toBe("off");
    updateModelSettings(sonnet46, { effort: "high" });
    expect(effectiveThinking(sonnet46)).toBe("shown");
  });

  it("reads the older show thinking setting", () => {
    updateModelSettings(opus, { showThinking: false });
    expect(effectiveThinking(opus)).toBe("hidden");
    expect(shouldShowReasoning(opus)).toBe(false);
    updateModelSettings(opus, { thinking: "shown" });
    expect(effectiveThinking(opus)).toBe("shown");
    expect(getModelSettings(opus).showThinking).toBe(true);
  });

  it("sends a chosen mode and keeps defaults as they were", () => {
    expect(getCompletionOptions(opus)).toMatchObject({
      nextcli_show_thinking: true,
    });
    expect(getCompletionOptions(opus)).not.toHaveProperty("nextcli_thinking");
    updateModelSettings(opus, { thinking: "hidden", effort: "low" });
    expect(getCompletionOptions(opus)).toMatchObject({
      nextcli_thinking: "hidden",
      reasoning_effort: "low",
    });
    // Opus 5.5 rejects `thinking: disabled`, so Off is never sent for it
    updateModelSettings(opus, { thinking: "off" });
    expect(getCompletionOptions(opus)).not.toMatchObject({
      nextcli_thinking: "off",
    });
    updateModelSettings(gpt, { thinking: "off" });
    expect(getCompletionOptions(gpt)).toMatchObject({
      reasoning_effort: "none",
    });
  });

  it("notes thinking off in the status label", () => {
    updateModelSettings(opus, { thinking: "off" });
    expect(modelStatusLabel(opus)).toContain("No thinking");
  });
});

describe("the last call of a run", () => {
  // What nextcli-checks configures: OpenAI-compatible, pointed at OneProvider
  const deepseek = model({
    provider: "openai",
    model: "deepseek-v4-pro",
    apiBase: "https://api.oneprovider.dev/v1",
  });

  beforeEach(() => {
    resetModelSettingsCache();
  });

  it("turns thinking off on a model that can, so the answer gets the tokens", () => {
    expect(getCompletionOptions(deepseek)).not.toHaveProperty("thinking");
    expect(getCompletionOptions(deepseek, { thinkingOff: true })).toMatchObject(
      { thinking: { type: "disabled" } },
    );
  });

  it("only changes that one call", () => {
    getCompletionOptions(deepseek, { thinkingOff: true });
    expect(getCompletionOptions(deepseek)).not.toHaveProperty("thinking");
  });

  it("leaves a model that always thinks alone", () => {
    // Opus 5.5 rejects `thinking: disabled`
    expect(getCompletionOptions(opus, { thinkingOff: true })).toEqual(
      getCompletionOptions(opus),
    );
  });

  it("asks an OpenAI reasoning model for no reasoning effort", () => {
    expect(getCompletionOptions(gpt, { thinkingOff: true })).toMatchObject({
      reasoning_effort: "none",
    });
  });
});
