import { describe, expect, it } from "vitest";

import {
  anthropicControlParams,
  anthropicThinkingOn,
  withAnthropicBetas,
} from "./anthropicControls.js";

describe("anthropicControlParams", () => {
  it("turns thinking off with disabled and keeps the effort", () => {
    expect(
      anthropicControlParams({
        model: "claude-opus-5-5",
        thinking: "off",
        effort: "low",
        maxTokens: 8000,
      }),
    ).toEqual({
      thinking: { type: "disabled" },
      outputConfig: { effort: "low" },
      maxTokens: 8000,
      betas: [],
    });
  });

  it("picks summarized or omitted text for the chosen mode", () => {
    expect(
      anthropicControlParams({
        model: "claude-opus-5-5",
        thinking: "shown",
        maxTokens: 8000,
      }).thinking,
    ).toEqual({ type: "adaptive", display: "summarized" });
    expect(
      anthropicControlParams({
        model: "claude-opus-5-5",
        thinking: "hidden",
        maxTokens: 8000,
      }).thinking,
    ).toEqual({ type: "adaptive", display: "omitted" });
  });

  it("turns adaptive thinking on for Claude 4.6 to 4.8 when a mode is chosen", () => {
    expect(
      anthropicControlParams({
        model: "claude-sonnet-4-6",
        thinking: "shown",
        maxTokens: 8000,
      }).thinking,
    ).toEqual({ type: "adaptive", display: "summarized" });
    // Without a mode, effort or budget, it keeps the model's default
    expect(
      anthropicControlParams({ model: "claude-sonnet-4-6", maxTokens: 8000 })
        .thinking,
    ).toBeUndefined();
  });

  it("uses a default budget on budget models when a mode is chosen", () => {
    expect(
      anthropicControlParams({
        model: "claude-haiku-4-5",
        thinking: "hidden",
        maxTokens: 8000,
      }),
    ).toMatchObject({
      thinking: { type: "enabled", budget_tokens: 2048 },
      maxTokens: 8000,
    });
    // The older showThinking flag alone doesn't turn it on
    expect(
      anthropicControlParams({
        model: "claude-haiku-4-5",
        showThinking: true,
        maxTokens: 8000,
      }).thinking,
    ).toBeUndefined();
  });

  it("raises max_tokens above the budget", () => {
    expect(
      anthropicControlParams({
        model: "claude-sonnet-4-5",
        effort: "high",
        maxTokens: 4096,
      }),
    ).toMatchObject({
      thinking: { type: "enabled", budget_tokens: 3072 },
      maxTokens: 4096,
    });
    expect(
      anthropicControlParams({
        model: "claude-sonnet-4-5",
        budgetTokens: 1024,
        maxTokens: 1500,
      }),
    ).toMatchObject({
      thinking: { type: "enabled", budget_tokens: 1024 },
      maxTokens: 2048,
    });
  });

  it("asks for fast mode and its beta where needed", () => {
    expect(
      anthropicControlParams({
        model: "claude-opus-5-5",
        fast: true,
        maxTokens: 8000,
      }),
    ).toMatchObject({ speed: "fast", betas: [] });
    expect(
      anthropicControlParams({
        model: "claude-opus-4-8",
        fast: true,
        maxTokens: 8000,
      }),
    ).toMatchObject({ speed: "fast", betas: ["fast-mode-2026-02-01"] });
    expect(
      anthropicControlParams({
        model: "claude-sonnet-5-5",
        fast: true,
        maxTokens: 8000,
      }),
    ).not.toHaveProperty("speed");
  });

  it("turns thinking on for the older reasoning flag", () => {
    expect(
      anthropicControlParams({
        model: "claude-sonnet-5-5",
        thinkingRequested: true,
        maxTokens: 8000,
      }).thinking,
    ).toEqual({ type: "adaptive" });
    expect(
      anthropicControlParams({
        model: "claude-haiku-4-5",
        thinkingRequested: true,
        maxTokens: 8000,
      }).thinking,
    ).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("leaves unknown models alone", () => {
    expect(
      anthropicControlParams({
        model: "my-proxy-model",
        thinking: "off",
        maxTokens: 8000,
      }).thinking,
    ).toBeUndefined();
  });
});

describe("helpers", () => {
  it("counts disabled thinking as off", () => {
    expect(anthropicThinkingOn({ type: "disabled" })).toBe(false);
    expect(anthropicThinkingOn({ type: "adaptive" })).toBe(true);
    expect(anthropicThinkingOn(undefined)).toBe(false);
  });

  it("merges beta flags without duplicates", () => {
    expect(withAnthropicBetas("a,b", ["b", "c"])).toBe("a,b,c");
    expect(withAnthropicBetas(undefined, [])).toBeUndefined();
  });
});
