import { beforeEach, describe, expect, it, vi } from "vitest";

import { trackStreamAttempts } from "./streamAttempts.js";
import { recordStreamTelemetry } from "./streamChatResponse.helpers.js";

vi.mock("./streamChatResponse.helpers.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordStreamTelemetry: vi.fn(() => 0),
}));

const contentChunk = (content: string) =>
  ({ choices: [{ index: 0, delta: { content } }] }) as any;

function tracker() {
  return trackStreamAttempts({
    requestStartTime: 1000,
    model: { model: "deepseek-v4.1-flash" },
    abortSignal: new AbortController().signal,
    estimateInputTokens: () => 12_000,
  });
}

describe("trackStreamAttempts", () => {
  beforeEach(() => {
    vi.mocked(recordStreamTelemetry).mockClear();
  });

  it("stamps the first token when it arrives", () => {
    vi.spyOn(Date, "now").mockReturnValue(1500);
    const attempts = tracker();

    attempts.onChunk!({ choices: [{ index: 0, delta: {} }] } as any);
    expect(attempts.firstTokenAt()).toBeUndefined();

    attempts.onChunk!(contentChunk("a"));
    vi.spyOn(Date, "now").mockReturnValue(9000);
    attempts.onChunk!(contentChunk("b"));

    expect(attempts.firstTokenAt()).toBe(1500);
    vi.restoreAllMocks();
  });

  it("records a discarded attempt with the provider's usage when it arrived", () => {
    const attempts = tracker();
    attempts.onChunk!(contentChunk("partial"));

    const error = Object.assign(new Error("provider stream failed\nbody"), {
      status: 502,
    });
    attempts.onDiscardedAttempt!(
      [
        contentChunk("partial"),
        { choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
        {
          choices: [],
          usage: { prompt_tokens: 30_000, completion_tokens: 900 },
        },
      ] as any,
      error,
    );

    expect(recordStreamTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 30_000,
        outputTokens: 900,
        fullUsage: { prompt_tokens: 30_000, completion_tokens: 900 },
        call: expect.objectContaining({
          discarded: true,
          finishReason: "length",
          contentChars: "partial".length,
          reasoningChars: 0,
          toolCalls: [],
          // First line only: providers can echo the request below it
          error: "provider stream failed",
          status: 502,
        }),
      }),
    );
    expect(attempts.recorded(error)).toBe(true);
    expect(attempts.recorded(new Error("other"))).toBe(false);
    // The next attempt measures its own first token
    expect(attempts.firstTokenAt()).toBeUndefined();
  });

  it("estimates a discarded attempt that died before its usage", () => {
    const attempts = tracker();

    attempts.onDiscardedAttempt!(
      [
        contentChunk("hello world"),
        {
          choices: [
            { index: 0, delta: { reasoning_content: "thinking about it" } },
          ],
        },
      ] as any,
      new Error("provider stream failed"),
    );

    const recorded = vi.mocked(recordStreamTelemetry).mock.calls[0][0];
    expect(recorded.inputTokens).toBe(12_000);
    expect(recorded.outputTokens).toBeGreaterThan(0);
    expect(recorded.fullUsage).toBeUndefined();
  });
});
