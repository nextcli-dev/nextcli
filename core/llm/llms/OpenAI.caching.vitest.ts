import { describe, expect, it } from "vitest";

import OpenAI from "./OpenAI.js";

const qwen = (options: object = {}) =>
  new OpenAI({
    model: "qwen4-max-preview",
    apiKey: "k",
    apiBase: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    ...options,
  });

const config = (llm: OpenAI) => (llm as any).adapterConfig();

describe("OpenAI prompt caching in core", () => {
  // The adapter marks Qwen hosts' requests unless told `none`; in the
  // extension caching is off until the model asks for it
  it("adds Qwen cache markers only when the model asks for caching", () => {
    expect(config(qwen()).cachingStrategy).toBe("none");
    for (const options of [
      { completionOptions: { promptCaching: true } },
      { cacheBehavior: { cacheConversation: true } },
      { cacheBehavior: { cacheSystemMessage: true } },
    ]) {
      expect(config(qwen(options)).cachingStrategy).toBeUndefined();
    }
  });

  it("sends a request without markers by default, and with them when asked", () => {
    const body = (llm: OpenAI) =>
      JSON.stringify(
        (llm as any).createOpenAiAdapter().modifyChatBody({
          model: "qwen4-max-preview",
          messages: [
            { role: "system", content: "You are a helper." },
            { role: "user", content: "Hi" },
          ],
        }),
      );
    expect(body(qwen())).not.toContain("cache_control");
    expect(
      body(qwen({ completionOptions: { promptCaching: true } })),
    ).toContain("cache_control");
  });
});
