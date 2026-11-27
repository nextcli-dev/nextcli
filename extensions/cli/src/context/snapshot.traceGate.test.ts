import type { ModelConfig } from "@nextcli/config-yaml";
import { describe, expect, it, vi } from "vitest";

vi.mock("../trace/trace.js", () => ({
  traceEnabled: () => true,
  // Chains are tested in context/snapshot.prefix.test.ts
  withTraceChain: (loop: unknown) => loop,
  currentTraceChain: () => ({}),
}));

import { tracedContext } from "./snapshot.js";

const model = {
  name: "Test",
  model: "test",
  provider: "openai",
  defaultCompletionOptions: { contextLength: 8_000, maxTokens: 1_000 },
} as ModelConfig;

describe("tracedContext", () => {
  it("builds a snapshot when traceEnabled is on, even if NEXTCLI_TRACE is unset", async () => {
    delete process.env.NEXTCLI_TRACE;
    const snapshot = await tracedContext({
      model,
      chatHistory: [],
      systemMessage: "You are a helper.",
    });
    expect(snapshot?.used).toBeGreaterThan(0);
  });
});
