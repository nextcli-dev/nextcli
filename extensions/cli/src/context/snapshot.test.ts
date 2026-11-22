import type { ModelConfig } from "@nextcli/config-yaml";
import type { ChatHistoryItem } from "core/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { countTotalInputTokens } from "../util/tokenizer.js";

import { tracedContext } from "./snapshot.js";

const model = {
  name: "Test",
  model: "test",
  provider: "openai",
  defaultCompletionOptions: { contextLength: 8_000, maxTokens: 1_000 },
} as ModelConfig;

const chatHistory: ChatHistoryItem[] = [
  { message: { role: "user", content: "hello" }, contextItems: [] },
];

describe("tracedContext", () => {
  afterEach(() => {
    delete process.env.NEXTCLI_TRACE;
  });

  it("does not build a snapshot when tracing is off", async () => {
    delete process.env.NEXTCLI_TRACE;
    expect(
      await tracedContext({
        model,
        chatHistory,
        systemMessage: "You are a helper.",
      }),
    ).toBeUndefined();
  });

  it("matches the tokens the request sends when tracing is on", async () => {
    process.env.NEXTCLI_TRACE = "basic";
    const systemMessage = "You are a helper.";
    const tools = [
      {
        type: "function" as const,
        function: { name: "read", description: "Read a file" },
      },
    ];
    const snapshot = await tracedContext({
      model,
      chatHistory,
      systemMessage,
      tools,
      mcpConnections: [],
    });
    expect(snapshot?.used).toBe(
      countTotalInputTokens({ chatHistory, model, systemMessage, tools }),
    );
  });
});
