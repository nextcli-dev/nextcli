import type { ChatHistoryItem } from "core/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleAutoCompaction as coreHandleAutoCompaction } from "../../stream/streamChatResponse.autoCompaction.js";

import { handleAutoCompaction } from "./useChat.compaction.js";

vi.mock("../../stream/streamChatResponse.autoCompaction.js", () => ({
  handleAutoCompaction: vi.fn(),
}));

vi.mock("../../session.js", () => ({
  updateSessionHistory: vi.fn(),
}));

describe("TUI auto-compaction before a message", () => {
  const history: ChatHistoryItem[] = [
    { message: { role: "user", content: "Hello" }, contextItems: [] },
  ];
  const message: ChatHistoryItem = {
    message: { role: "user", content: "Next" },
    contextItems: [],
  };
  const summary: ChatHistoryItem = {
    message: { role: "assistant", content: "Summary" },
    contextItems: [],
    conversationSummary: "Summary",
  };
  let abortController: AbortController;
  const run = () =>
    handleAutoCompaction({
      chatHistory: history,
      model: {},
      llmApi: {},
      compactionIndex: 2,
      setChatHistory: vi.fn(),
      setCompactionIndex: vi.fn(),
      abortController,
      message,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    abortController = new AbortController();
  });

  it("sends nothing when Escape cancels the compaction", async () => {
    vi.mocked(coreHandleAutoCompaction).mockImplementation(async () => {
      // Escape while the summary streams
      abortController.abort();
      return {
        chatHistory: history,
        compactionIndex: null,
        wasCompacted: false,
      };
    });

    const result = await run();

    // The compaction got the controller Escape aborts
    expect(vi.mocked(coreHandleAutoCompaction).mock.calls[0][3]).toMatchObject({
      abortController,
    });
    // No history with the message, so no turn starts
    expect(result).toBeNull();
  });

  it("sends the message after the history when no compaction is needed", async () => {
    vi.mocked(coreHandleAutoCompaction).mockResolvedValue({
      chatHistory: history,
      compactionIndex: null,
      wasCompacted: false,
    });

    expect(await run()).toEqual({
      newHistory: [...history, message],
      currentCompactionIndex: 2,
    });
  });

  it("sends the message after the summary and a notice once compacted", async () => {
    vi.mocked(coreHandleAutoCompaction).mockResolvedValue({
      chatHistory: [summary],
      compactionIndex: 0,
      wasCompacted: true,
    });

    expect(await run()).toEqual({
      newHistory: [
        summary,
        {
          message: {
            role: "system",
            content: "Chat history auto-compacted successfully.",
          },
          contextItems: [],
        },
        message,
      ],
      currentCompactionIndex: 0,
    });
  });

  it("tells the person what the summary lost", async () => {
    vi.mocked(coreHandleAutoCompaction).mockResolvedValue({
      chatHistory: [summary],
      compactionIndex: 0,
      wasCompacted: true,
      omittedMessages: 2,
      shortenedOutputs: 0,
    });

    const result = await run();

    // Shown in the TUI; role:"system" items are never sent to the model
    expect(result?.newHistory[1].message).toEqual({
      role: "system",
      content: expect.stringContaining("2 earlier messages were left out"),
    });
    expect(result?.newHistory.at(-1)).toBe(message);
  });
});
