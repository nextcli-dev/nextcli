import { describe, expect, it, vi } from "vitest";

import { BedrockApi } from "../apis/Bedrock.js";

/** A Bedrock client whose ConverseStream answers with these events */
function bedrockWith(events: object[]) {
  const api = new BedrockApi({
    provider: "bedrock",
    env: { region: "us-east-1", accessKeyId: "a", secretAccessKey: "s" },
  });
  // Test mock: no AWS call
  vi.spyOn(api, "getClient").mockResolvedValue({
    send: async () => ({
      stream: (async function* () {
        yield* events;
      })(),
    }),
  } as unknown as Awaited<ReturnType<BedrockApi["getClient"]>>);
  return api;
}

const answer = {
  contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Done." } },
};
const metadata = {
  metadata: {
    usage: {
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadInputTokens: 3000,
      cacheWriteInputTokens: 500,
      totalTokens: 4780,
    },
    metrics: { latencyMs: 10 },
  },
};
const body = {
  model: "anthropic.claude-sonnet-5-5",
  messages: [{ role: "user" as const, content: "Fix it." }],
};
const expected = {
  prompt_tokens: 4700,
  completion_tokens: 80,
  total_tokens: 4780,
  prompt_tokens_details: {
    cached_tokens: 3000,
    cache_read_tokens: 3000,
    cache_write_tokens: 500,
  },
};

describe("BedrockApi usage", () => {
  // Without it the CLI priced every Bedrock request at $0, and --max-cost
  // never counted it
  it("streams the metadata event's usage, cache reads and writes in the prompt", async () => {
    const chunks = [];
    for await (const chunk of bedrockWith([
      answer,
      metadata,
    ]).chatCompletionStream(
      { ...body, stream: true },
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.choices[0]?.delta.content)).toEqual([
      "Done.",
      undefined,
    ]);
    expect(chunks.at(-1)?.usage).toEqual(expected);
  });

  it("returns the usage from a non-streamed request", async () => {
    const completion = await bedrockWith([
      answer,
      metadata,
    ]).chatCompletionNonStream(body, new AbortController().signal);
    expect(completion.choices[0].message.content).toBe("Done.");
    expect(completion.usage).toEqual(expected);
  });
});
