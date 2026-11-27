import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import { convertToUnifiedHistory } from "core/util/messageConversion.js";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.mjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { compactChatHistory } from "./compaction.js";
import { services } from "./services/index.js";

// The summary request goes through the real agent loop to a fake provider,
// so the test sees the messages that would be sent.

const mcpState = vi.hoisted(() => ({ tools: [] as unknown[] }));

vi.mock("./services/index.js", () => ({
  services: {
    // One array: the request prefix rebuilds when the MCP tools change
    mcp: { getState: vi.fn(() => mcpState) },
    systemMessage: {
      getSystemMessage: vi.fn(() => Promise.resolve("System prompt")),
    },
    toolPermissions: {
      getState: vi.fn(() => ({ currentMode: "enabled" })),
      isHeadless: vi.fn(() => true),
    },
    // Ready, as in the CLI: a write before the check would land here
    chatHistory: {
      isReady: vi.fn(() => true),
      getHistory: vi.fn(() => []),
      addAssistantMessage: vi.fn(),
      setHistory: vi.fn(),
    },
  },
}));

// The next request's tools, which the summary is sized to fit; none here
vi.mock("./stream/handleToolCalls.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stream/handleToolCalls.js")>()),
  getRequestTools: vi.fn(async () => []),
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
    // Cut only as far as the request needs
    const toolResult = String(messages[3].content);
    expect(toolResult.length).toBeLessThan(100_000);
    expect(toolResult.length).toBeGreaterThan(10_000);
    expect(toolResult).toContain("tool output truncated");
    expect(result).toMatchObject({ omittedMessages: 0, shortenedOutputs: 1 });
  });

  it("leaves out nothing the request itself has room for", async () => {
    // Claude counts carry a multiplier. Compaction must use the request's own
    // check, so a history the request has room for is sent whole.
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

  describe("sized for the request after it", () => {
    // A 6K answer reserve in a 10K window: a summary that used it all
    // wouldn't fit beside the next request's own reserve
    const bigReserve = {
      ...model,
      defaultCompletionOptions: { contextLength: 10_000, maxTokens: 6_000 },
    } as ModelConfig;
    const tool = {
      type: "function" as const,
      function: {
        name: "Read",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
      },
    };
    const next = { tools: [tool], followedBy: [user("go on")] };
    const sentRequest = () =>
      vi.mocked(llmApi.chatCompletionStream).mock
        .calls[0][0] as ChatCompletionCreateParamsStreaming;

    it("caps the summary at the room the next request leaves", async () => {
      const result = await compactChatHistory(
        [user("the task"), assistant("done")],
        bigReserve,
        llmApi,
        next,
      );

      // 10,000 - 6,000 reserve - 100 buffer - the prompt, tool and "go on"
      expect(sentRequest().max_tokens).toBeLessThan(4_000);
      expect(sentRequest().max_tokens).toBeGreaterThan(3_500);
      expect(result.compactionContent).toBe("Summary");
      // Returned, not stored: the caller writes it
      expect(services.chatHistory.addAssistantMessage).not.toHaveBeenCalled();
    });

    it("fails, and returns nothing to write, when the summary is too long anyway", async () => {
      // A provider that ignores max_tokens
      vi.mocked(llmApi.chatCompletionStream).mockImplementation(
        async function* () {
          yield {
            id: "1",
            object: "chat.completion.chunk",
            created: 0,
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                delta: { content: " word".repeat(5_000) },
                finish_reason: null,
              },
            ],
          };
        } as never,
      );

      await expect(
        compactChatHistory(
          [user("the task"), assistant("done")],
          bigReserve,
          llmApi,
          next,
        ),
      ).rejects.toThrow(
        /The summary \([\d,]+ tokens\) doesn't fit the request after it/,
      );
      // The summary stream wrote nothing to the live history either
      expect(services.chatHistory.addAssistantMessage).not.toHaveBeenCalled();
      expect(services.chatHistory.setHistory).not.toHaveBeenCalled();
    });

    it("fails before any call when the next request leaves no room", async () => {
      const noRoom = {
        ...model,
        defaultCompletionOptions: { contextLength: 10_000, maxTokens: 9_000 },
      } as ModelConfig;

      await expect(
        compactChatHistory(
          [user("the task"), assistant("done")],
          noRoom,
          llmApi,
          next,
        ),
      ).rejects.toThrow(
        /the tools \([\d,]+ tokens\).*the room kept for the answer \(9,000 tokens\)/,
      );
      expect(llmApi.chatCompletionStream).not.toHaveBeenCalled();
    });
  });
});
