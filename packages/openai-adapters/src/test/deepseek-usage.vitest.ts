import { describe, expect, it, vi } from "vitest";

const usage = {
  prompt_tokens: 1000,
  completion_tokens: 300,
  total_tokens: 1300,
  prompt_cache_hit_tokens: 800,
  prompt_cache_miss_tokens: 200,
};

vi.mock("../util.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util.js")>();
  const chunk = (extra: object) =>
    JSON.stringify({
      id: "c",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-v4-pro",
      ...extra,
    });
  return {
    ...actual,
    customFetch: () => async () =>
      new Response(
        `data: ${chunk({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n` +
          `data: ${chunk({ choices: [], usage })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
  };
});

import { constructLlmApi } from "../index.js";

describe("DeepSeek usage", () => {
  // DeepSeek's own API reports cache hits only as prompt_cache_hit_tokens;
  // the CLI and core read it from the usage the adapter passes on
  it("passes the stream's usage on with DeepSeek's cache fields", async () => {
    const api = constructLlmApi({ provider: "deepseek", apiKey: "k" })!;
    const chunks = [];
    for await (const chunk of api.chatCompletionStream(
      {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }
    expect(chunks.at(-1)?.usage).toMatchObject({
      prompt_cache_hit_tokens: 800,
    });
  });
});
