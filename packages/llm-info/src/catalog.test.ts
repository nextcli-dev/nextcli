import { describe, expect, it } from "vitest";

import {
  allModelProviders,
  CATALOG_PROVIDERS,
  findCatalogModel,
  findCatalogModelsByCanonical,
  findLlmInfo,
} from "./index.js";
import { CATALOG } from "./generated/catalog.js";

describe("catalog snapshot", () => {
  it("has every provider NextCLI maps to it, with models", () => {
    for (const [provider, catalogId] of Object.entries(CATALOG_PROVIDERS)) {
      expect(
        Object.keys(CATALOG[catalogId] ?? {}).length,
        `${provider} -> ${catalogId}`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps the fields the model controls and prices use", () => {
    const claude = CATALOG.anthropic["claude-sonnet-5-5"];
    expect(claude.context).toBeGreaterThan(0);
    expect(claude.output).toBeGreaterThan(0);
    expect(claude.reasoning).toBe(true);
    expect(claude.efforts?.length).toBeGreaterThan(0);
    expect(claude.cost?.input).toBeGreaterThan(0);
    expect(claude.cost?.cacheRead).toBeGreaterThan(0);
    expect(CATALOG.openai["gpt-5.5"].fast?.body).toEqual({
      service_tier: "priority",
    });
  });

  it("has well-formed prices", () => {
    for (const models of Object.values(CATALOG)) {
      for (const model of Object.values(models)) {
        if (!model.cost) continue;
        expect(model.cost.input).toBeGreaterThanOrEqual(0);
        expect(model.cost.output).toBeGreaterThanOrEqual(0);
        for (const tier of model.cost.tiers ?? []) {
          expect(tier.above).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("findCatalogModel", () => {
  it.each([
    ["anthropic", "claude-sonnet-5-5", "claude-sonnet-5-5"],
    // Case and dots ignored
    ["anthropic", "Claude-Sonnet-5.5", "claude-sonnet-5-5"],
    ["openrouter", "anthropic/claude-haiku-4-5", "anthropic/claude-haiku-4.5"],
    // A vendor prefix on a provider that isn't OpenRouter
    ["anthropic", "anthropic/claude-sonnet-5-5", "claude-sonnet-5-5"],
    // A dated snapshot of a listed id
    ["openai", "gpt-5.5-2026-04-23", "gpt-5.5"],
    // A listed preview of the id
    ["google", "gemini-3.1-pro", "gemini-3.1-pro-preview"],
  ])("finds %s %s as %s", (provider, model, id) => {
    expect(findCatalogModel(provider, model)?.id).toBe(id);
  });

  it.each([
    // Different models, not variants
    ["openai", "gpt-5-mini", "gpt-5-mini"],
    ["anthropic", "claude-sonnet-4-5", "claude-sonnet-4-5"],
  ])("keeps %s %s apart from its family", (provider, model, id) => {
    expect(findCatalogModel(provider, model)?.id).toBe(id);
  });

  it("finds nothing for an unknown model or provider", () => {
    expect(findCatalogModel("anthropic", "my-local-model")).toBeUndefined();
    expect(findCatalogModel("no-such-provider", "gpt-5.5")).toBeUndefined();
    expect(findCatalogModel(undefined, "gpt-5.5")).toBeUndefined();
    // gpt-5.6 is listed; a made-up suffix is not a variant
    expect(findCatalogModel("openai", "gpt-5.6-custom")).toBeUndefined();
  });

  it("finds every provider's entry for a canonical id", () => {
    const matches = findCatalogModelsByCanonical("deepseek/deepseek-v4-pro");
    expect(matches.length).toBeGreaterThan(1);
    for (const match of matches) {
      expect(match.model.canonical).toBe("deepseek/deepseek-v4-pro");
    }
  });
});

describe("findLlmInfo", () => {
  it("prefers the hand-written table for the models it lists", () => {
    const hand = allModelProviders
      .find((p) => p.id === "anthropic")!
      .models.find((m) => m.model === "claude-sonnet-5-5")!;
    const info = findLlmInfo("claude-sonnet-5-5", "anthropic");
    expect(info?.contextLength).toBe(hand.contextLength);
    expect(info?.maxCompletionTokens).toBe(hand.maxCompletionTokens);
  });

  it("uses the catalog for the provider's models the tables don't list", () => {
    // Groq has no hand-written table
    const catalogModel = CATALOG.groq["llama-3.3-70b-versatile"];
    expect(findLlmInfo("llama-3.3-70b-versatile", "groq")).toMatchObject({
      provider: "groq",
      contextLength: catalogModel.context,
      maxCompletionTokens: catalogModel.output,
    });
  });

  it("reads images from the catalog", () => {
    expect(findLlmInfo("openai/gpt-5.5", "openrouter")?.mediaTypes).toContain(
      "image",
    );
  });
});
