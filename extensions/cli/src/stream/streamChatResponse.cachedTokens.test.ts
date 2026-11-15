import { describe, expect, it } from "vitest";

import { recordStreamTelemetry } from "./streamChatResponse.helpers.js";

function cost(fullUsage: Record<string, unknown>) {
  return recordStreamTelemetry({
    requestStartTime: 0,
    responseEndTime: 1,
    inputTokens: 0,
    outputTokens: 0,
    model: { provider: "openai", model: "gpt-6.1-sol" },
    fullUsage,
    call: {},
  });
}

describe("recordStreamTelemetry cache reads", () => {
  // Same request and price as calculateRequestCost.vitest.ts: 8000 of the
  // 10,000 prompt tokens were cache reads
  const usage = { prompt_tokens: 10_000, completion_tokens: 1000 };

  it("bills OpenAI's cached_tokens at the cached rate", () => {
    expect(
      cost({ ...usage, prompt_tokens_details: { cached_tokens: 8000 } }),
    ).toBeCloseTo(0.0148, 6);
  });

  it("reads the adapters' cache_read_tokens the same way", () => {
    expect(
      cost({
        ...usage,
        prompt_tokens_details: { cached_tokens: 8000, cache_read_tokens: 8000 },
      }),
    ).toBeCloseTo(0.0148, 6);
  });

  it("bills every prompt token at the input rate without cache details", () => {
    expect(cost(usage)).toBeGreaterThan(0.0148);
  });
});
