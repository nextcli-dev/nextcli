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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gives the compaction the controller Escape aborts", async () => {
    const abortController = new AbortController();
    const setChatHistory = vi.fn();
    vi.mocked(coreHandleAutoCompaction).mockImplementation(async () => {
      // Escape while the summary streams
      abortController.abort();
      return {
        chatHistory: history,
        compactionIndex: null,
        wasCompacted: false,
      };
    });

    const result = await handleAutoCompaction({
      chatHistory: history,
      model: {},
      llmApi: {},
      compactionIndex: 2,
      setChatHistory,
      setCompactionIndex: vi.fn(),
      abortController,
    });

    expect(vi.mocked(coreHandleAutoCompaction).mock.calls[0][3]).toMatchObject({
      abortController,
    });
    // A cancelled compaction leaves the conversation as it was
    expect(result).toEqual({
      currentChatHistory: history,
      currentCompactionIndex: 2,
    });
    expect(setChatHistory).not.toHaveBeenCalled();
  });
});
