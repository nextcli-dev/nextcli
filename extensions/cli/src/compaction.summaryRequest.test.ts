import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import { convertToUnifiedHistory } from "core/util/messageConversion.js";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.mjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { compactChatHistory } from "./compaction.js";

// The summary request goes through the real agent loop to a fake provider,
// so the test sees the messages that would be sent.

vi.mock("./services/index.js", () => ({
  services: {
    systemMessage: {
      getSystemMessage: vi.fn(() => Promise.resolve("System prompt")),
    },
    toolPermissions: {
      getState: vi.fn(() => ({ currentMode: "enabled" })),
      isHeadless: vi.fn(() => true),
    },
    chatHistory: { isReady: vi.fn(() => false) },
  },
}));

vi.mock("./session.js", () => ({
  updateSessionHistory: vi.fn(),
  trackSessionUsage: vi.fn(),
  getSessionUsage: vi.fn(() => ({
    promptTokens: 0,
    completionTokens: 0,
    totalCost: 0,
  })),
}));

vi.mock("./util/logger.js", () => ({
  logger: {
    trace: vi.fn(),
    verbose: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const user = (content: string): ChatHistoryItem => ({
  message: { role: "user", content },
  contextItems: [],
});
const assistant = (content: string): ChatHistoryItem => ({
  message: { role: "assistant", content },
  contextItems: [],
});

describe("the summary request compaction sends", () => {
  // 10K window, 1K output
  const model = {
    name: "small",
    provider: "openai",
    model: "gpt-4o",
    defaultCompletionOptions: { contextLength: 10_000, maxTokens: 1_000 },
  } as ModelConfig;
  let llmApi: BaseLlmApi;
  const sentMessages = () =>
    (
      vi.mocked(llmApi.chatCompletionStream).mock
        .calls[0][0] as ChatCompletionCreateParamsStreaming
    ).messages;

  beforeEach(() => {
    vi.clearAllMocks();
    llmApi = {
      chatCompletionStream: vi.fn().mockImplementation(async function* () {
        yield {
          id: "1",
          object: "chat.completion.chunk",
          created: 0,
          model: "gpt-4o",
          choices: [
            { index: 0, delta: { content: "Summary" }, finish_reason: null },
          ],
        };
      }),
    } as unknown as BaseLlmApi;
  });

  it("holds the newest turn, then the instruction", async () => {
    // An older turn that can't fit, then the task being worked on
    const history = [
      user(" hello".repeat(9_000)),
      assistant("ok"),
      user("the task"),
      assistant("the last step"),
    ];

    const result = await compactChatHistory(history, model, llmApi);

    const contents = sentMessages().map((m) => String(m.content));
    expect(contents[0]).toBe("System prompt");
    expect(contents[1]).toMatch(/^\[Context note: 2 earlier .*the task$/s);
    expect(contents[2]).toBe("the last step");
    expect(contents[3]).toContain("concise summary");
    expect(contents).toHaveLength(4);
    expect(result).toMatchObject({
      compactionContent: "Summary",
      omittedMessages: 2,
    });
  });

  it("is not sent when the newest turn alone doesn't fit", async () => {
    const history = [
      user("old"),
      assistant("ok"),
      user("the task"),
      assistant(" hello".repeat(12_000)),
    ];

    await expect(compactChatHistory(history, model, llmApi)).rejects.toThrow(
      "left as it is",
    );
    expect(llmApi.chatCompletionStream).not.toHaveBeenCalled();
  });

  it("shortens a tool result that alone fills the window, instead of failing", async () => {
    // One task, one step whose Read result is 100,000 characters: more than
    // this window holds, and nothing older to leave out
    const history = convertToUnifiedHistory([
      { role: "user", content: "the task" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "Read", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: " word".repeat(20_000) },
    ]);

    const result = await compactChatHistory(history, model, llmApi);

    const messages = sentMessages();
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    const toolResult = String(messages[3].content);
    expect(toolResult.length).toBeLessThan(2_200);
    expect(toolResult).toContain("tool output truncated");
    expect(result).toMatchObject({ omittedMessages: 0, shortenedOutputs: 1 });
  });

  it("leaves out nothing the request itself has room for", async () => {
    // Claude counts get a multiplier. Compaction used it on the system prompt
    // where the request check doesn't, and counted the instruction twice, so
    // this history was cut although the request fit.
    const claude = {
      ...model,
      model: "claude-test",
    } as ModelConfig;
    const history = [
      user(" hello".repeat(1_800)),
      assistant(" hello".repeat(1_800)),
      user("go on"),
    ];

    const result = await compactChatHistory(history, claude, llmApi, {
      systemMessage: " hello".repeat(4_000),
    });

    expect(sentMessages()).toHaveLength(5);
    expect(result).toMatchObject({ omittedMessages: 0, shortenedOutputs: 0 });
  });
});
