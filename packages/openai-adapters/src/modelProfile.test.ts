import { describe, expect, it } from "vitest";

import { overriddenEfforts } from "./catalogOverrides.js";
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
