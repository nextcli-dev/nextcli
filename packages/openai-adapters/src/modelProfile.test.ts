import {
  findModelsDevModel,
  matchCatalogs,
  SUPPLEMENT,
} from "@nextcli/llm-info";
import { describe, expect, it } from "vitest";

import { overriddenEfforts } from "./catalogOverrides.js";
import { getContextOptions, getModelControls } from "./modelControls.js";
import { resolveModelProfile, vendorCatalogProvider } from "./modelProfile.js";

describe("resolveModelProfile", () => {
  it("reads a vendor's model from its own catalog", () => {
    const profile = resolveModelProfile({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    });
    expect(profile).toMatchObject({
      format: "anthropic",
      catalogProvider: "anthropic",
      fim: false,
      thinkingAlwaysOn: false,
    });
    expect(profile.catalog?.context).toBeGreaterThan(0);
  });

  it("reads OneProvider's models from their vendors' catalogs", () => {
    for (const [model, catalogProvider] of [
      ["claude-opus-5-5", "anthropic"],
      ["deepseek-v4-pro", "deepseek"],
      ["gpt-5.5", "openai"],
      ["gemini-3.5-flash", "google"],
      ["grok-4.7", "xai"],
      ["kimi-k3", "moonshotai"],
    ]) {
      const profile = resolveModelProfile({ provider: "oneprovider", model });
      expect(profile.catalogProvider, model).toBe(catalogProvider);
      expect(profile.catalog, model).toBeDefined();
    }
  });

  it("treats any provider on a OneProvider host as OneProvider", () => {
    expect(
      resolveModelProfile({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiBase: "https://api.oneprovider.dev",
      }),
    ).toMatchObject({ format: "deepseek", catalogProvider: "deepseek" });
  });

  it("maps a -thinking id to the base model with thinking on", () => {
    const profile = resolveModelProfile({
      provider: "oneprovider",
      model: "claude-sonnet-5-5-thinking",
    });
    expect(profile.thinkingAlwaysOn).toBe(true);
    expect(profile.catalog).toBeDefined();
    // Only OneProvider names models that way
    expect(
      resolveModelProfile({ provider: "moonshot", model: "kimi-k2-thinking" })
        .thinkingAlwaysOn,
    ).toBe(false);
  });

  it("applies no catalog to custom OpenAI-compatible endpoints", () => {
    expect(
      resolveModelProfile({
        provider: "openai",
        model: "gpt-5.5",
        apiBase: "http://127.0.0.1:8091/v1",
      }),
    ).toMatchObject({ format: "generic", catalogProvider: undefined });
    expect(
      resolveModelProfile({ provider: "lmstudio", model: "qwen3-coder" })
        .catalog,
    ).toBeUndefined();
  });

  it("reads Groq's catalog from its host under any provider name", () => {
    const profile = resolveModelProfile({
      provider: "openai",
      model: "openai/gpt-oss-120b",
      apiBase: "https://api.groq.com/openai/v1",
    });
    expect(profile.catalogProvider).toBe("groq");
    expect(profile.catalog?.context).toBeGreaterThan(0);
  });

  it("finds Claude on Bedrock through Anthropic's entry", () => {
    expect(
      resolveModelProfile({
        provider: "bedrock",
        model: "us.anthropic.claude-opus-5-5-v1:0",
      }).catalog?.efforts,
    ).toContain("max");
  });

  it("knows which endpoints serve FIM", () => {
    expect(
      resolveModelProfile({ provider: "deepseek", model: "deepseek-v4-pro" })
        .fim,
    ).toBe(true);
    expect(
      resolveModelProfile({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiBase: "https://api.oneprovider.dev",
      }).fim,
    ).toBe(false);
  });
});

describe("NextCLI's model supplement", () => {
  // Qwen Cloud's token plan, set up as an OpenAI-compatible endpoint
  const qwen = {
    provider: "openai",
    model: "qwen4-max-preview",
    apiBase: "https://token-plan.maas.qwencloudapi.com/v1/",
  };

  it("describes a model models.dev doesn't list on its vendor's host", () => {
    const profile = resolveModelProfile(qwen);
    expect(profile).toMatchObject({
      format: "generic",
      catalogProvider: "alibaba",
    });
    expect(profile.catalog).toMatchObject({ context: 1_000_000 });

    // The menu gets thinking, guessed efforts and the model's own window
    const controls = getModelControls(qwen);
    expect(controls).toMatchObject({
      efforts: ["low", "medium", "high"],
      experimental: true,
      thinkingModes: ["hidden", "shown"],
      maxContextLength: 983_000,
    });
    expect(getContextOptions(controls.maxContextLength, 32_768)).toEqual([
      32_768, 64_000, 128_000, 200_000, 256_000, 400_000, 983_000,
    ]);
  });

  it("leaves models models.dev lists to models.dev", () => {
    const identity = { ...qwen, model: "qwen3.8-max" };
    expect(resolveModelProfile(identity).catalogProvider).toBe("alibaba");
    expect(findModelsDevModel("alibaba", "qwen3.8-max")).toBeDefined();
    // models.dev's own levels, not a guess
    expect(getModelControls(identity)).toMatchObject({
      efforts: ["low", "medium", "xhigh"],
      experimental: false,
      maxContextLength: 1_000_000,
    });
  });

  it("isn't used on hosts that aren't the vendor's", () => {
    expect(
      resolveModelProfile({ ...qwen, apiBase: "https://gateway.example/v1/" })
        .catalog,
    ).toBeUndefined();
  });

  it("prefers an entry for the model itself to a variant's", () => {
    // Stand-ins: models.dev lists a dated snapshot, the supplement the model
    const modelsDev = { a: { "m-2026-12-01": { context: 1 } } };
    const supplement = { a: { m: { context: 2 }, n: { context: 3 } } };
    const catalogs = [modelsDev, supplement];
    expect(matchCatalogs(catalogs, "a", "m")?.model.context).toBe(2);
    expect(matchCatalogs(catalogs, "a", "m-2026-12-01")?.model.context).toBe(1);
    // At the same strength the earlier catalog wins
    expect(
      matchCatalogs([{ a: { m: { context: 4 } } }, supplement], "a", "m")?.model
        .context,
    ).toBe(4);
    // A variant falls through to the next catalog only when the first has
    // nothing for it
    expect(matchCatalogs(catalogs, "a", "n-preview")?.model.context).toBe(3);
    expect(
      matchCatalogs(catalogs, "a", "n-preview", { variants: false }),
    ).toBeUndefined();
  });

  // models.dev wins once it lists a model, so the supplement's entry is dead
  // weight: delete it from packages/llm-info/src/supplement.ts
  it("only lists models the models.dev snapshot doesn't", () => {
    for (const [provider, models] of Object.entries(SUPPLEMENT)) {
      for (const id of Object.keys(models)) {
        expect(
          findModelsDevModel(provider, id),
          `models.dev now lists ${provider}/${id}`,
        ).toBeUndefined();
      }
    }
  });
});

describe("vendorCatalogProvider", () => {
  it("reads OpenRouter's vendor slugs and plain model names", () => {
    expect(vendorCatalogProvider("x-ai/grok-4.7")).toBe("xai");
    expect(vendorCatalogProvider("google/gemini-3.5-flash")).toBe("google");
    expect(vendorCatalogProvider("anthropic/claude-opus-5.5")).toBe(
      "anthropic",
    );
    expect(vendorCatalogProvider("claude-opus-5-5")).toBe("anthropic");
    expect(vendorCatalogProvider("qwen/qwen3-max")).toBeUndefined();
  });
});

describe("catalog overrides", () => {
  it("keeps Grok's live-checked minimal level and DeepSeek without efforts", () => {
    expect(overriddenEfforts("xai", "grok-4.7")?.[0]).toBe("minimal");
    expect(
      overriddenEfforts("xai", "grok-4.20-0309-reasoning"),
    ).toBeUndefined();
    expect(overriddenEfforts("deepseek", "deepseek-v4-pro")).toEqual([]);
  });
});
