import { describe, expect, it } from "vitest";

import { LLMClasses } from "./index";

// Providers whose classes say their API has no legacy completions endpoint
const CHAT_ONLY = [
  "clawrouter",
  "llamastack",
  "minimax",
  "moonshot",
  "nebius",
  "nous",
  "nvidia",
  "openrouter",
  "ovhcloud",
  "scaleway",
  "siliconflow",
  "tars",
  "tensorix",
  "zAI",
];

function llm(provider: string, options: object = {}) {
  const cls = LLMClasses.find((c) => c.providerName === provider)!;
  return new (cls as any)({
    model: "qwen3-coder-30b",
    apiKey: "k",
    ...options,
  });
}

/** The URL an autocomplete request (raw completion) goes to */
async function autocompleteUrl(provider: string): Promise<string> {
  const instance = llm(provider);
  const urls: string[] = [];
  instance.fetch = async (url: URL | string) => {
    urls.push(String(url));
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  for await (const _ of instance.streamComplete(
    "prefix",
    new AbortController().signal,
    { raw: true },
  )) {
    // drain
  }
  return urls[0];
}

describe("legacy completions endpoint", () => {
  it("is off for providers whose API has none", () => {
    for (const provider of CHAT_ONLY) {
      expect(llm(provider).supportsCompletions(), provider).toBe(false);
    }
  });

  it("sends their autocomplete to chat completions", async () => {
    expect(await autocompleteUrl("moonshot")).toBe(
      "https://api.moonshot.ai/v1/chat/completions",
    );
    expect(await autocompleteUrl("openrouter")).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(await autocompleteUrl("nebius")).toBe(
      "https://api.studio.nebius.ai/v1/chat/completions",
    );
  });

  it("follows the model config over the provider's default", () => {
    expect(
      llm("openrouter", {
        useLegacyCompletionsEndpoint: true,
      }).supportsCompletions(),
    ).toBe(true);
    expect(
      llm("openai", {
        useLegacyCompletionsEndpoint: false,
      }).supportsCompletions(),
    ).toBe(false);
  });

  it("stays on for an OpenAI-compatible server that doesn't say", () => {
    expect(
      llm("openai", {
        apiBase: "http://localhost:8000/v1/",
      }).supportsCompletions(),
    ).toBe(true);
    expect(llm("together").supportsCompletions()).toBe(true);
  });
});
