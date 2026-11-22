import { describe, expect, it, vi } from "vitest";

const traceEvent = vi.hoisted(() => vi.fn());

vi.mock("../trace/trace.js", () => ({
  traceEvent,
  traceEnabled: () => process.env.NEXTCLI_TRACE?.trim().toLowerCase() === "basic",
}));

vi.mock("../util/logger.js", () => ({
  logger: { verbose: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "../util/logger.js";

import { recordStreamTelemetry } from "./streamChatResponse.helpers.js";

describe("request context on the trace", () => {
  it("writes the snapshot on the trace and leaves it off the log line", () => {
    const context = {
      window: 2000,
      used: 10,
      threshold: {
        tokens: 1000,
        action: "auto-compaction" as const,
        steps: [{ label: "model context length", tokens: 2000 }],
      },
      segments: [],
      largestToolResults: [],
    };
    recordStreamTelemetry({
      requestStartTime: 0,
      responseEndTime: 1,
      inputTokens: 10,
      outputTokens: 2,
      model: { provider: "openai", model: "gpt-6.1-sol" },
      context,
      call: {},
    });
    expect(traceEvent).toHaveBeenCalledWith(
      "llm.request",
      expect.objectContaining({ context }),
      expect.any(Object),
    );
    const logged = vi.mocked(logger.verbose).mock.calls.at(-1)?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(logged?.context).toBeUndefined();
  });
});
