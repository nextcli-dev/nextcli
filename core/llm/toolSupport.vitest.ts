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

describe("modelSupportsNativeTools with the models.dev catalog", () => {
  it("follows the catalog for a model it lists", () => {
    // Groq has no hand-written rule: its catalog decides
    expect(
      modelSupportsNativeTools(model("groq", "llama-3.3-70b-versatile")),
    ).toBe(true);
    expect(
      modelSupportsNativeTools(
        model("groq", "meta-llama/llama-prompt-guard-2-22m"),
      ),
    ).toBe(false);
    // The catalog's "no" wins over the provider's rule (every gemini id)
    expect(
      modelSupportsNativeTools(model("gemini", "gemini-2.5-flash-image")),
    ).toBe(false);
    expect(modelSupportsNativeTools(model("gemini", "gemini-2.5-pro"))).toBe(
      true,
    );
  });

  it("lets the config's capabilities win over the catalog", () => {
    expect(
      modelSupportsNativeTools(
        model("groq", "llama-3.3-70b-versatile", {
          capabilities: { tools: false },
        }),
      ),
    ).toBe(false);
    expect(
      modelSupportsNativeTools(
        model("groq", "meta-llama/llama-prompt-guard-2-22m", {
          capabilities: { tools: true },
        }),
      ),
    ).toBe(true);
  });

  it("leaves a model the catalog doesn't list to the provider's rule", () => {
    // A bridge: OpenAI's rule by name
    const bridge = { apiBase: "http://localhost:8091/v1" };
    expect(modelSupportsNativeTools(model("openai", "gpt-5.5", bridge))).toBe(
      true,
    );
    expect(
      modelSupportsNativeTools(
        model("openai", "llama-3.3-70b-versatile", bridge),
      ),
    ).toBe(false);
    expect(modelSupportsNativeTools(model("ollama", "qwen3:8b"))).toBe(true);
  });
});
