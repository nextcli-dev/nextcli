import { describe, expect, it } from "vitest";

import { ModelDescription } from "..";

import { modelSupportsNativeTools } from "./toolSupport";

function model(
  provider: string,
  id: string,
  extra: Partial<ModelDescription> = {},
): ModelDescription {
  return {
    title: id,
    provider,
    model: id,
    underlyingProviderName: provider,
    ...extra,
  };
}

const supports = (provider: string, id: string, extra = {}) =>
  modelSupportsNativeTools(model(provider, id, extra));

describe("modelSupportsNativeTools", () => {
  it("follows the models.dev catalog for a provider without a rule", () => {
    // Groq has no hand-written rule: its catalog decides, both ways
    expect(supports("groq", "llama-3.3-70b-versatile")).toBe(true);
    expect(supports("groq", "meta-llama/llama-prompt-guard-2-22m")).toBe(false);
    // Not in the catalog, and no rule
    expect(supports("groq", "not-a-model")).toBe(false);
  });

  it("lets a provider's rule decide over the catalog", () => {
    // OpenRouter's allowlist, where the catalog says the opposite
    expect(supports("openrouter", "meta-llama/llama-3.2-3b-instruct")).toBe(
      true,
    );
    expect(supports("openrouter", "liquid/lfm-3-1.7b:free")).toBe(false);
    expect(supports("openrouter", "moonshotai/kimi-k2:free")).toBe(false);
    // Every gemini id, though the catalog lists this one without tools
    expect(supports("gemini", "gemini-2.5-flash-image")).toBe(true);
    // OpenAI's rule (gpt-4 and later), whatever the catalog says
    expect(supports("openai", "gpt-3.5-turbo")).toBe(false);
  });

  it("lets the config's capabilities win over both", () => {
    expect(
      supports("groq", "llama-3.3-70b-versatile", {
        capabilities: { tools: false },
      }),
    ).toBe(false);
    expect(
      supports("groq", "meta-llama/llama-prompt-guard-2-22m", {
        capabilities: { tools: true },
      }),
    ).toBe(true);
    expect(
      supports("openrouter", "liquid/lfm-3-1.7b:free", {
        capabilities: { tools: true },
      }),
    ).toBe(true);
  });

  it("leaves a bridge's model to the provider's rule", () => {
    const bridge = { apiBase: "http://localhost:8091/v1" };
    expect(supports("openai", "gpt-5.5", bridge)).toBe(true);
    expect(supports("openai", "llama-3.3-70b-versatile", bridge)).toBe(false);
    expect(supports("ollama", "qwen3:8b")).toBe(true);
  });
});
