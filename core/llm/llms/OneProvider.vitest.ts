import { describe, expect, it } from "vitest";

import OneProvider from "./OneProvider.js";

function oneProvider(options: object = {}) {
  return new OneProvider({
    model: "claude-sonnet-5-5",
    apiKey: "k",
    ...options,
  });
}

describe("OneProvider", () => {
  // The OneProvider adapter sends Claude to AnthropicApi, which would cache
  // by default; core caches only when the model asks, as its Anthropic
  // class does
  it("caches Claude prompts only when the model asks for it", () => {
    const config = (llm: OneProvider) => (llm as any).adapterConfig();
    expect(config(oneProvider()).cachingStrategy).toBe("none");
    expect(
      config(oneProvider({ cacheBehavior: { cacheConversation: true } }))
        .cachingStrategy,
    ).toBe("systemAndTools");
    expect(
      config(oneProvider({ cacheBehavior: { cacheSystemMessage: true } }))
        .cachingStrategy,
    ).toBe("systemAndTools");
    expect(
      config(oneProvider({ completionOptions: { promptCaching: true } }))
        .cachingStrategy,
    ).toBe("systemAndTools");
  });

  it("passes the transport and OneProvider's API base to the adapter", () => {
    expect(
      (oneProvider({ transport: "ai-sdk" }) as any).adapterConfig(),
    ).toMatchObject({
      provider: "oneprovider",
      apiBase: "https://api.oneprovider.dev/v1/",
      transport: "ai-sdk",
    });
  });

  it("sends Claude its signed thinking back, and others reasoning_content", () => {
    const claude = oneProvider() as any;
    expect(claude.supportsReasoningDetailsField).toBe(true);
    expect(claude.supportsReasoningContentField).toBe(false);
    const deepseek = oneProvider({ model: "deepseek-v4-pro" }) as any;
    expect(deepseek.supportsReasoningDetailsField).toBe(false);
    expect(deepseek.supportsReasoningContentField).toBe(true);
  });
});
