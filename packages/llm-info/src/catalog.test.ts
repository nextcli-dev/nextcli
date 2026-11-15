import { describe, expect, it } from "vitest";

import {
  allModelProviders,
  CATALOG_PROVIDERS,
  catalogPromptLimit,
  catalogProviderFor,
  catalogProviderForApiBase,
  findCatalogCost,
  findCatalogModel,
  findCatalogModelsByCanonical,
  findGeneralCost,
  findLlmInfo,
  hasUnknownZeroPrice,
  hostOf,
  isLocalHost,
  resolveCatalog,
  type ModelEndpoint,
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

describe("catalogProviderFor", () => {
  it("matches provider names without case, and tolerates none", () => {
    expect(catalogProviderFor("xAI")).toBe("xai");
    expect(catalogProviderFor("xai")).toBe("xai");
    expect(catalogProviderFor("together")).toBe("togetherai");
    expect(catalogProviderFor("my-gateway")).toBeUndefined();
    expect(catalogProviderFor(undefined)).toBeUndefined();
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

  it.each([
    // Mistral's -latest alias, not the oldest dated (YYMM) snapshot
    ["mistral", "mistral-large", "mistral-large-latest"],
    ["mistral", "mistral-medium", "mistral-medium-latest"],
    ["mistral", "mistral-small", "mistral-small-latest"],
    ["mistral", "codestral", "codestral-latest"],
    // A current snapshot, not the thinking variant that sorts first
    ["openrouter", "qwen/qwen3-235b-a22b", "qwen/qwen3-235b-a22b-2507"],
    // A listed snapshot is used as it is
    ["mistral", "mistral-medium-2505", "mistral-medium-2505"],
  ])("finds unsuffixed %s %s as %s", (provider, model, id) => {
    expect(findCatalogModel(provider, model)?.id).toBe(id);
  });

  it("gives a dated snapshot its alias's fast mode", () => {
    // OpenAI's catalog lists priority for gpt-4o only
    expect(CATALOG.openai["gpt-4o-2024-08-06"].fast).toBeUndefined();
    const snapshot = findCatalogModel("openai", "gpt-4o-2024-08-06")?.model;
    expect(snapshot?.fast).toEqual(CATALOG.openai["gpt-4o"].fast);
    // A snapshot priced differently keeps its own fast prices
    expect(findCatalogModel("openai", "gpt-4o-2024-05-13")?.model.fast).toEqual(
      CATALOG.openai["gpt-4o-2024-05-13"].fast,
    );
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
    });
  });

  it("leaves the output limit of catalog-only models to the default", () => {
    // Many entries list the whole window as the output limit; as the
    // default max_tokens it would reserve a quarter of the window per call
    for (const [model, provider] of [
      ["kimi-k3", "moonshot"],
      ["grok-4.5", "xAI"],
      ["llama-3.3-70b-versatile", "groq"],
      ["anthropic/claude-sonnet-4.5", "openrouter"],
    ]) {
      const info = findLlmInfo(model, provider);
      expect(info?.contextLength, model).toBeGreaterThan(0);
      expect(info?.maxCompletionTokens, model).toBeUndefined();
    }
  });

  it("applies no catalog to a custom OpenAI-compatible endpoint", () => {
    // gpt-5.6 is only in the catalog, not the hand table
    expect(findLlmInfo("gpt-5.6", "openai")?.contextLength).toBeGreaterThan(0);
    expect(
      findLlmInfo("gpt-5.6", "openai", "http://127.0.0.1:8091/v1"),
    ).toBeUndefined();
    // Groq's host brings Groq's catalog under the openai provider
    expect(
      findLlmInfo(
        "llama-3.3-70b-versatile",
        "openai",
        "https://api.groq.com/openai/v1",
      )?.contextLength,
    ).toBe(CATALOG.groq["llama-3.3-70b-versatile"].context);
  });

  it("fills the context a hand-written row leaves out from the catalog", () => {
    // The row for mistral-medium sets no context; the -latest entry does
    const info = findLlmInfo("mistral-medium", "mistral");
    expect(info?.contextLength).toBe(
      CATALOG.mistral["mistral-medium-latest"].context,
    );
    // The row's output limit stays unset: it sets the default max_tokens
    expect(info?.maxCompletionTokens).toBeUndefined();
  });

  it("plans for the input limit, not the whole context window", () => {
    const gpt = CATALOG.openai["gpt-5.5"];
    expect(gpt.input).toBeLessThan(gpt.context!);
    expect(findLlmInfo("gpt-5.5", "openai")?.contextLength).toBe(gpt.input);
    expect(catalogPromptLimit(gpt)).toBe(gpt.input);
  });

  it("reads images from the catalog", () => {
    expect(findLlmInfo("openai/gpt-5.5", "openrouter")?.mediaTypes).toContain(
      "image",
    );
  });
});

describe("prices", () => {
  it("reads a provider's own price", () => {
    expect(findCatalogCost("deepseek", "deepseek-v4-pro")).toEqual(
      CATALOG.deepseek["deepseek-v4-pro"].cost,
    );
    expect(findCatalogCost(undefined, "deepseek-v4-pro")).toBeUndefined();
  });

  it("gives a general price from OpenRouter for a model on any host", () => {
    const openrouter = CATALOG.openrouter["deepseek/deepseek-v4-pro"].cost;
    expect(findGeneralCost("deepseek-v4-pro")).toEqual(openrouter);
    // Maker names find OpenRouter's dotted names
    expect(findGeneralCost("claude-opus-5-5")).toEqual(
      CATALOG.openrouter["anthropic/claude-opus-5.5"].cost,
    );
    // A dated snapshot of a priced model
    expect(findGeneralCost("deepseek-v4-pro-20260801")).toEqual(openrouter);
    expect(findGeneralCost("my-local-finetune")).toBeUndefined();
  });

  it("treats a $0 catalog price as unknown, except OpenRouter's :free ids", () => {
    // models.dev lists $0 where it doesn't know the price
    expect(CATALOG.groq["allam-2-7b"].cost).toMatchObject({
      input: 0,
      output: 0,
    });
    expect(findCatalogCost("groq", "allam-2-7b")).toBeUndefined();
    expect(hasUnknownZeroPrice("groq", "allam-2-7b")).toBe(true);
    // OpenRouter's :free variants really are free
    const free = "google/gemma-4-31b-it:free";
    expect(findCatalogCost("openrouter", free)).toMatchObject({
      input: 0,
      output: 0,
    });
    expect(hasUnknownZeroPrice("openrouter", free)).toBe(false);
    // A priced model is untouched
    expect(hasUnknownZeroPrice("groq", "openai/gpt-oss-120b")).toBe(false);
  });

  it("knows Groq's catalog from its API host", () => {
    expect(catalogProviderForApiBase("https://api.groq.com/openai/v1")).toBe(
      "groq",
    );
    expect(
      catalogProviderForApiBase("https://openpaths.io/v1"),
    ).toBeUndefined();
    expect(catalogProviderForApiBase(undefined)).toBeUndefined();
    expect(catalogProviderForApiBase("not a url")).toBeUndefined();
  });

  it("never uses a free price as the general price", () => {
    for (const [id, model] of Object.entries(CATALOG.openrouter)) {
      if (!id.endsWith(":free")) continue;
      const general = findGeneralCost(id.replace(/:free$/, ""));
      if (general) expect(general.input).toBeGreaterThan(0);
      expect(model.cost?.input ?? 0).toBe(0);
    }
  });
});

describe("resolveCatalog", () => {
  it("answers which catalog describes a model on its endpoint", () => {
    const cases: Array<[ModelEndpoint, string | undefined, string]> = [
      [
        { provider: "anthropic", model: "claude-opus-5-5" },
        "anthropic",
        "other",
      ],
      [{ provider: "openai", model: "gpt-5.5" }, "openai", "other"],
      [
        {
          provider: "openai",
          model: "gpt-5.5",
          apiBase: "https://openpaths.io/v1",
        },
        undefined,
        "other",
      ],
      [
        { provider: "openai", model: "x", apiBase: "http://localhost:8091/v1" },
        undefined,
        "this-machine",
      ],
      [
        {
          provider: "openai",
          model: "llama-3.3-70b-versatile",
          apiBase: "https://api.groq.com/openai/v1",
        },
        "groq",
        "catalog-host",
      ],
      [
        {
          provider: "openai",
          model: "anthropic/claude-sonnet-4.5",
          apiBase: "https://openrouter.ai/api/v1",
        },
        "openrouter",
        "catalog-host",
      ],
      [
        {
          provider: "deepseek",
          model: "deepseek-v4-pro",
          apiBase: "https://api.oneprovider.dev/v1",
        },
        "deepseek",
        "oneprovider",
      ],
      [
        { provider: "oneprovider", model: "claude-sonnet-5-5-thinking" },
        "anthropic",
        "oneprovider",
      ],
    ];
    for (const [endpoint, catalogProvider, host] of cases) {
      const route = resolveCatalog(endpoint);
      expect(route.catalogProvider, JSON.stringify(endpoint)).toBe(
        catalogProvider,
      );
      expect(route.host, JSON.stringify(endpoint)).toBe(host);
    }
    expect(
      resolveCatalog({
        provider: "oneprovider",
        model: "claude-sonnet-5-5-thinking",
      }),
    ).toMatchObject({
      thinkingAlwaysOn: true,
      match: { id: "claude-sonnet-5-5" },
    });
    // Claude on Bedrock falls back to Anthropic's entry
    expect(
      resolveCatalog({
        provider: "bedrock",
        model: "us.anthropic.claude-opus-5-5-v1:0",
      }).match?.model.efforts,
    ).toContain("max");
  });

  it("counts only this machine as local, containers included", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "[::1]",
      "app.localhost",
      "host.docker.internal",
      "host.containers.internal",
    ]) {
      expect(isLocalHost(host), host).toBe(true);
    }
    // ::ffff:127.0.0.1, as URL writes it
    expect(isLocalHost(hostOf("http://[::ffff:127.0.0.1]:8091")!)).toBe(true);
    for (const host of [
      "10.0.0.5",
      "172.20.1.2",
      "192.168.1.20",
      "gpu-box.local",
      "api.openai.com",
    ]) {
      expect(isLocalHost(host), host).toBe(false);
    }
  });
});
