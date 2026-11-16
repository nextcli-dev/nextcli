import { describe, expect, it } from "vitest";

import { aiSdkRoute, selectTransport } from "../transport.js";

const BRIDGE = { provider: "openai", apiBase: "http://127.0.0.1:8091/v1" };

describe("selectTransport", () => {
  it("keeps the provider's own adapter by default", () => {
    expect(selectTransport(BRIDGE, {})).toBe("legacy");
  });

  it("opts in with NEXTCLI_USE_AI_SDK, or its old name", () => {
    expect(selectTransport(BRIDGE, { NEXTCLI_USE_AI_SDK: "1" })).toBe("ai-sdk");
    expect(selectTransport(BRIDGE, { CONTINUE_USE_AI_SDK: "true" })).toBe(
      "ai-sdk",
    );
  });

  it('reads "0", "false" and an empty value as off', () => {
    for (const value of ["0", "false", "FALSE", ""]) {
      expect(selectTransport(BRIDGE, { NEXTCLI_USE_AI_SDK: value })).toBe(
        "legacy",
      );
    }
  });

  it("lets the model's transport win over the environment", () => {
    expect(
      selectTransport(
        { ...BRIDGE, transport: "legacy" },
        { NEXTCLI_USE_AI_SDK: "1" },
      ),
    ).toBe("legacy");
    expect(
      selectTransport(
        {
          provider: "deepseek",
          apiBase: "https://gateway.example/v1",
          transport: "ai-sdk",
        },
        {},
      ),
    ).toBe("ai-sdk");
  });

  // So a config the AI SDK can't serve gets the plain adapter, not a
  // wrapper that passes every request on
  it("ignores both where the endpoint has no AI-SDK route", () => {
    const asked = { NEXTCLI_USE_AI_SDK: "1" };
    for (const config of [
      { provider: "bedrock" },
      { provider: "anthropic" },
      { provider: "openai" },
      { provider: "openai", apiBase: "https://api.openai.com/v1" },
      { provider: "deepseek" },
      { provider: "deepseek", apiBase: "https://api.deepseek.com/" },
    ]) {
      expect(selectTransport({ ...config, transport: "ai-sdk" }, asked)).toBe(
        "legacy",
      );
    }
    expect(selectTransport({ provider: "oneprovider" }, asked)).toBe("ai-sdk");
  });
});

describe("aiSdkRoute", () => {
  it("sends custom OpenAI-compatible endpoints through the compatible provider", () => {
    for (const apiBase of [
      "http://127.0.0.1:8091/v1",
      "https://api.oneprovider.dev/v1",
      "https://api.groq.com/openai/v1",
    ]) {
      expect(aiSdkRoute({ provider: "openai", model: "any", apiBase })).toEqual(
        { factory: "openai-compatible" },
      );
    }
  });

  it("keeps Claude on the Anthropic adapter, OneProvider's included", () => {
    expect(
      aiSdkRoute({ provider: "oneprovider", model: "deepseek-v4-pro" }),
    ).toEqual({ factory: "openai-compatible" });
    expect(
      aiSdkRoute({ provider: "oneprovider", model: "claude-opus-5-5" }),
    ).toBeUndefined();
    expect(
      aiSdkRoute({ provider: "anthropic", model: "claude-sonnet-5-5" }),
    ).toBeUndefined();
  });

  it("fills empty reasoning_content for DeepSeek on a gateway only", () => {
    expect(
      aiSdkRoute({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiBase: "https://gateway.example/v1",
      }),
    ).toEqual({ factory: "openai-compatible", emptyReasoningContent: true });
    // DeepSeek's own API, with its FIM, keeps its adapter
    expect(
      aiSdkRoute({ provider: "deepseek", model: "deepseek-v4-pro" }),
    ).toBeUndefined();
    expect(
      aiSdkRoute({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiBase: "https://api.deepseek.com/",
      }),
    ).toBeUndefined();
  });
});
