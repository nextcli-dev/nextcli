import { describe, expect, it } from "vitest";

import { aiSdkRoute, selectTransport } from "../transport.js";

describe("selectTransport", () => {
  it("keeps the provider's own adapter by default", () => {
    expect(selectTransport({ provider: "openai" }, {})).toBe("legacy");
  });

  it("opts in with NEXTCLI_USE_AI_SDK, or its old name", () => {
    expect(
      selectTransport({ provider: "openai" }, { NEXTCLI_USE_AI_SDK: "1" }),
    ).toBe("ai-sdk");
    expect(
      selectTransport({ provider: "openai" }, { CONTINUE_USE_AI_SDK: "true" }),
    ).toBe("ai-sdk");
  });

  it('reads "0", "false" and an empty value as off', () => {
    for (const value of ["0", "false", "FALSE", ""]) {
      expect(
        selectTransport({ provider: "openai" }, { NEXTCLI_USE_AI_SDK: value }),
      ).toBe("legacy");
    }
  });

  it("lets the model's transport win over the environment", () => {
    expect(
      selectTransport(
        { provider: "openai", transport: "legacy" },
        { NEXTCLI_USE_AI_SDK: "1" },
      ),
    ).toBe("legacy");
    expect(
      selectTransport({ provider: "deepseek", transport: "ai-sdk" }, {}),
    ).toBe("ai-sdk");
  });

  it("ignores both for a provider without AI-SDK routes", () => {
    expect(
      selectTransport(
        { provider: "bedrock", transport: "ai-sdk" },
        { NEXTCLI_USE_AI_SDK: "1" },
      ),
    ).toBe("legacy");
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

  it("routes OneProvider by model: Claude to Messages, the rest compatible", () => {
    expect(
      aiSdkRoute({ provider: "oneprovider", model: "deepseek-v4-pro" }),
    ).toEqual({ factory: "openai-compatible" });
    expect(
      aiSdkRoute({ provider: "oneprovider", model: "claude-opus-5-5" }),
    ).toEqual({ factory: "anthropic" });
  });

  it("sends Claude through the Anthropic provider, except on Azure", () => {
    expect(
      aiSdkRoute({ provider: "anthropic", model: "claude-sonnet-5-5" }),
    ).toEqual({ factory: "anthropic" });
    expect(
      aiSdkRoute({
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        apiBase: "https://claude.services.ai.azure.com/anthropic/v1",
      }),
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
