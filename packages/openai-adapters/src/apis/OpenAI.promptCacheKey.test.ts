import { describe, expect, it, vi } from "vitest";

import { constructLlmApi } from "../index.js";

function api(apiBase: string) {
  return constructLlmApi({
    provider: "openai",
    apiKey: "sk-test",
    apiBase,
    promptCacheKey: "run-key",
  }) as any;
}

async function drain(stream: AsyncIterable<unknown>) {
  for await (const _ of stream);
}

const request = (model: string) => ({
  model,
  messages: [{ role: "user" as const, content: "Hi" }],
  stream: true as const,
});

describe("OpenAI prompt_cache_key", () => {
  it("goes with Chat Completions and Responses requests to api.openai.com", async () => {
    const openai = api("https://api.openai.com/v1/");
    const create = vi
      .spyOn(openai.openai.chat.completions, "create")
      .mockResolvedValue((async function* () {})());
    const responses = vi
      .spyOn(openai.openai.responses, "stream")
      .mockReturnValue((async function* () {})());
    const signal = new AbortController().signal;

    await drain(openai.chatCompletionStream(request("gpt-4.1-mini"), signal));
    await drain(openai.chatCompletionStream(request("gpt-5.4-mini"), signal));

    expect(create.mock.calls[0]![0]).toMatchObject({
      prompt_cache_key: "run-key",
    });
    expect(responses.mock.calls[0]![0]).toMatchObject({
      prompt_cache_key: "run-key",
    });
  });

  it("isn't sent to other hosts", async () => {
    const other = api("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
    const create = vi
      .spyOn(other.openai.chat.completions, "create")
      .mockResolvedValue((async function* () {})());

    await drain(
      other.chatCompletionStream(
        request("qwen4-max-preview"),
        new AbortController().signal,
      ),
    );

    expect(create.mock.calls[0]![0]).not.toHaveProperty("prompt_cache_key");
  });

  it("isn't added by the Responses helpers for other hosts", async () => {
    const other = api("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
    const stream = vi
      .spyOn(other.openai.responses, "stream")
      .mockReturnValue((async function* () {})());
    const create = vi
      .spyOn(other.openai.responses, "create")
      .mockResolvedValue({ output: [] });
    const signal = new AbortController().signal;

    await drain(other.responsesStream(request("gpt-5.4-mini"), signal));
    await other.responsesNonStream(
      { ...request("gpt-5.4-mini"), stream: false },
      signal,
    );

    expect(stream.mock.calls[0]![0]).not.toHaveProperty("prompt_cache_key");
    expect(create.mock.calls[0]![0]).not.toHaveProperty("prompt_cache_key");
  });
});
