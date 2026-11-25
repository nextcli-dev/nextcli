import type { ChatHistoryItem } from "core/index.js";
import { convertToUnifiedHistory } from "core/util/messageConversion.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleAutoCompaction } from "./streamChatResponse.autoCompaction.js";

// Mock dependencies
vi.mock("../compaction.js", async (importOriginal) => ({
  // The request's defaults, when the caller passes none
  currentSystemMessage: vi.fn(async () => "Current system message"),
  currentRequestTools: vi.fn(async () => []),
  compactionDoneMessage: (
    await importOriginal<typeof import("../compaction.js")>()
  ).compactionDoneMessage,
  compactChatHistory: vi.fn(),
  shouldAutoCompact: vi.fn(),
  getAutoCompactMessage: vi.fn(),
  isCompactionAborted: (error: Error) => error?.name === "AbortError",
}));

vi.mock("../init.js", () => ({ safeStderr: vi.fn() }));

vi.mock("../session.js", () => ({
  createSession: vi.fn((history) => ({
    sessionId: "test",
    title: "Test",
    workspaceDirectory: "/test",
    history,
  })),
  saveSession: vi.fn(),
  updateSessionHistory: vi.fn(),
  trackSessionUsage: vi.fn(),
}));

vi.mock("../util/tokenizer.js", () => ({
  historySentToModel: (history: { message: { role: string } }[]) =>
    history.filter((item) => item.message.role !== "system"),
  countChatHistoryItemTokens: vi.fn(() => 100), // Mock return value
}));

vi.mock("../util/formatError.js", () => ({
  formatError: vi.fn((error) => error.message || String(error)),
}));

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../services/index.js", () => ({
  services: {
    systemMessage: {
      getSystemMessage: vi.fn(() => Promise.resolve("System message")),
    },
    toolPermissions: {
      getState: vi.fn(() => ({ currentMode: "enabled" })),
    },
  },
}));

vi.mock("os", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    homedir: vi.fn(() => "/home/test"),
  };
});

describe("handleAutoCompaction", () => {
  const mockModel = {
    provider: "openai",
    name: "gpt-4",
    model: "gpt-4",
    defaultCompletionOptions: {
      contextLength: 8192,
      maxTokens: 2048,
    },
  } as any;

  const mockLlmApi = {} as any;
  const mockChatHistory: ChatHistoryItem[] = convertToUnifiedHistory([
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there!" },
  ]);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts the system prompt and tools the caller passes, as the agent loop does", async () => {
    const { shouldAutoCompact, currentSystemMessage, currentRequestTools } =
      await import("../compaction.js");
    vi.mocked(shouldAutoCompact).mockReturnValue(false);
    const tools = [
      {
        type: "function" as const,
        function: { name: "Read", parameters: {} },
      },
    ];

    await handleAutoCompaction(mockChatHistory, mockModel, mockLlmApi, {
      systemMessage: "Loop system message",
      tools,
    });

    expect(shouldAutoCompact).toHaveBeenCalledWith({
      chatHistory: mockChatHistory,
      model: mockModel,
      systemMessage: "Loop system message",
      tools,
    });
    expect(currentSystemMessage).not.toHaveBeenCalled();
    expect(currentRequestTools).not.toHaveBeenCalled();
  });

  it("should return original history when auto-compaction is not needed", async () => {
    const { shouldAutoCompact } = await import("../compaction.js");
    const mockedShouldAutoCompact = shouldAutoCompact as any;
    mockedShouldAutoCompact.mockReturnValue(false);

    const result = await handleAutoCompaction(
      mockChatHistory,
      mockModel,
      mockLlmApi,
      {},
    );

    expect(result).toEqual({
      chatHistory: mockChatHistory,
      compactionIndex: null,
      wasCompacted: false,
    });

    // Called with no system prompt or tools (as before a user message), the
    // trigger counts the ones the request will carry
    expect(shouldAutoCompact).toHaveBeenCalledWith({
      chatHistory: mockChatHistory,
      model: mockModel,
      systemMessage: "Current system message",
      tools: [],
    });
  });

  it("should perform auto-compaction when context limit is approaching", async () => {
    const { compactChatHistory, shouldAutoCompact, getAutoCompactMessage } =
      await import("../compaction.js");
    const { updateSessionHistory } = await import("../session.js");

    vi.mocked(shouldAutoCompact).mockReturnValue(true);
    vi.mocked(getAutoCompactMessage).mockReturnValue("Auto-compacting...");

    const mockCompactionResult = {
      compactedHistory: convertToUnifiedHistory([
        {
          role: "system",
          content: "You are a helpful assistant.",
        },
        {
          role: "assistant",
          content: "[COMPACTED HISTORY]\nConversation summary...",
        },
      ]),
      compactionIndex: 1,
      compactionContent: "Conversation summary...",
    };

    const mockedCompactChatHistory = compactChatHistory as any;
    mockedCompactChatHistory.mockResolvedValue(mockCompactionResult);

    const mockCallbacks = {
      onSystemMessage: vi.fn(),
    };

    const result = await handleAutoCompaction(
      mockChatHistory,
      mockModel,
      mockLlmApi,
      {
        isHeadless: false,
        callbacks: mockCallbacks,
      },
    );

    // Called with no system prompt or tools (as before a user message), the
    // trigger counts the ones the request will carry
    expect(shouldAutoCompact).toHaveBeenCalledWith({
      chatHistory: mockChatHistory,
      model: mockModel,
      systemMessage: "Current system message",
      tools: [],
    });
    expect(getAutoCompactMessage).toHaveBeenCalledWith(mockModel);
    expect(compactChatHistory).toHaveBeenCalledWith(
      mockChatHistory,
      mockModel,
      mockLlmApi,
      expect.objectContaining({
        callbacks: expect.any(Object),
      }),
    );
    // The caller writes the result through the history service
    expect(updateSessionHistory).not.toHaveBeenCalled();
    expect(result.chatHistory).toEqual(mockCompactionResult.compactedHistory);

    expect(mockCallbacks.onSystemMessage).toHaveBeenCalledWith(
      "Auto-compacting...",
    );
    expect(mockCallbacks.onSystemMessage).toHaveBeenCalledWith(
      "Chat history auto-compacted successfully.",
    );

    expect(result).toEqual({
      chatHistory: mockCompactionResult.compactedHistory,
      compactionIndex: mockCompactionResult.compactionIndex,
      wasCompacted: true,
    });
  });

  it("should handle compaction errors gracefully", async () => {
    const { compactChatHistory, shouldAutoCompact, getAutoCompactMessage } =
      await import("../compaction.js");
    const { logger } = await import("../util/logger.js");

    vi.mocked(shouldAutoCompact).mockReturnValue(true);
    vi.mocked(getAutoCompactMessage).mockReturnValue("Auto-compacting...");
    vi.mocked(compactChatHistory).mockRejectedValue(
      new Error("Compaction failed"),
    );

    const mockCallbacks = {
      onSystemMessage: vi.fn(),
    };

    const result = await handleAutoCompaction(
      mockChatHistory,
      mockModel,
      mockLlmApi,
      {
        isHeadless: false,
        callbacks: mockCallbacks,
      },
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Auto-compaction error"),
    );
    expect(mockCallbacks.onSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining("Warning: Auto-compaction error"),
    );

    // Should return original history on error
    expect(result.wasCompacted).toBe(false);
    expect(result).toEqual({
      chatHistory: mockChatHistory,
      compactionIndex: null,
      wasCompacted: false,
      // The reason goes back to the caller, which may stop the run with it
      error: new Error("Compaction failed"),
    });
  });

  it("says how many of the oldest messages the summary left out", async () => {
    const { compactChatHistory, shouldAutoCompact } = await import(
      "../compaction.js"
    );
    vi.mocked(shouldAutoCompact).mockReturnValue(true);
    vi.mocked(compactChatHistory).mockResolvedValue({
      compactedHistory: [],
      compactionIndex: 0,
      compactionContent: "Summary",
      omittedMessages: 3,
      shortenedOutputs: 1,
    });
    const onSystemMessage = vi.fn();

    const result = await handleAutoCompaction(
      mockChatHistory,
      mockModel,
      mockLlmApi,
      { callbacks: { onSystemMessage }, systemMessage: "Loop prompt" },
    );

    // The summary request goes with the prompt the loop sends
    expect(vi.mocked(compactChatHistory).mock.calls[0][3]).toMatchObject({
      systemMessage: "Loop prompt",
    });
    expect(onSystemMessage).toHaveBeenLastCalledWith(
      "Chat history auto-compacted successfully. To fit the summary request, 3 earlier messages were left out and 1 tool output was shortened. What was cut isn't in the summary.",
    );
    expect(result).toMatchObject({ omittedMessages: 3, shortenedOutputs: 1 });
  });

  it("says on stderr what an unattended run's summary lost", async () => {
    const { compactChatHistory, shouldAutoCompact } = await import(
      "../compaction.js"
    );
    const { safeStderr } = await import("../init.js");
    vi.mocked(shouldAutoCompact).mockReturnValue(true);
    vi.mocked(compactChatHistory).mockResolvedValue({
      compactedHistory: [],
      compactionIndex: 0,
      compactionContent: "Summary",
      omittedMessages: 0,
      shortenedOutputs: 2,
    });

    await handleAutoCompaction(mockChatHistory, mockModel, mockLlmApi, {
      isHeadless: true,
    });

    expect(safeStderr).toHaveBeenCalledWith(
      expect.stringMatching(/^Warning: .*2 tool outputs were shortened/),
    );
  });

  it("says on stderr why an unattended run's compaction failed, and writes nothing", async () => {
    const { compactChatHistory, shouldAutoCompact } = await import(
      "../compaction.js"
    );
    const { safeStderr } = await import("../init.js");
    const { updateSessionHistory } = await import("../session.js");
    vi.mocked(shouldAutoCompact).mockReturnValue(true);
    vi.mocked(compactChatHistory).mockRejectedValue(
      new Error("No room for a summary"),
    );

    const result = await handleAutoCompaction(
      mockChatHistory,
      mockModel,
      mockLlmApi,
      { isHeadless: true },
    );

    expect(safeStderr).toHaveBeenCalledWith(
      expect.stringContaining("Auto-compaction error: No room for a summary"),
    );
    expect(updateSessionHistory).not.toHaveBeenCalled();
    expect(result.error?.message).toBe("No room for a summary");
  });

  it("says nothing on stderr when the summary covers everything", async () => {
    const { compactChatHistory, shouldAutoCompact } = await import(
      "../compaction.js"
    );
    const { safeStderr } = await import("../init.js");
    vi.mocked(shouldAutoCompact).mockReturnValue(true);
    vi.mocked(compactChatHistory).mockResolvedValue({
      compactedHistory: [],
      compactionIndex: 0,
      compactionContent: "Summary",
      omittedMessages: 0,
      shortenedOutputs: 0,
    });

    await handleAutoCompaction(mockChatHistory, mockModel, mockLlmApi, {
      isHeadless: true,
    });

    expect(safeStderr).not.toHaveBeenCalled();
  });

  it("returns the history unchanged and warns nobody when cancelled", async () => {
    const { compactChatHistory, shouldAutoCompact } = await import(
      "../compaction.js"
    );
    const { updateSessionHistory } = await import("../session.js");
    const abortController = new AbortController();
    vi.mocked(shouldAutoCompact).mockReturnValue(true);
    vi.mocked(compactChatHistory).mockImplementation(async () => {
      abortController.abort();
      throw Object.assign(new Error("Compaction cancelled"), {
        name: "AbortError",
      });
    });
    const onSystemMessage = vi.fn();

    const result = await handleAutoCompaction(
      mockChatHistory,
      mockModel,
      mockLlmApi,
      { callbacks: { onSystemMessage }, abortController },
    );

    expect(result).toEqual({
      chatHistory: mockChatHistory,
      compactionIndex: null,
      wasCompacted: false,
    });
    expect(vi.mocked(compactChatHistory).mock.calls[0][3]).toMatchObject({
      abortController,
    });
    expect(updateSessionHistory).not.toHaveBeenCalled();
    // Only the start notice: no "Auto-compaction error" warning
    expect(onSystemMessage).toHaveBeenCalledTimes(1);
    expect(onSystemMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("error"),
    );
  });

  it("should not call system message callback in headless mode", async () => {
    const { compactChatHistory, shouldAutoCompact, getAutoCompactMessage } =
      await import("../compaction.js");

    vi.mocked(shouldAutoCompact).mockReturnValue(true);
    vi.mocked(getAutoCompactMessage).mockReturnValue("Auto-compacting...");

    const mockCompactionResult = {
      compactedHistory: convertToUnifiedHistory([
        { role: "system", content: "System" },
      ]),
      compactionIndex: 0,
      compactionContent: "Summary",
    };

    const mockedCompactChatHistory = compactChatHistory as any;
    mockedCompactChatHistory.mockResolvedValue(mockCompactionResult);

    const mockCallbacks = {
      onSystemMessage: vi.fn(),
    };

    await handleAutoCompaction(mockChatHistory, mockModel, mockLlmApi, {
      isHeadless: true,
      callbacks: mockCallbacks,
    });

    expect(mockCallbacks.onSystemMessage).not.toHaveBeenCalled();
  });

  it("should handle missing model gracefully", async () => {
    const result = await handleAutoCompaction(
      mockChatHistory,
      null as any,
      mockLlmApi,
      {},
    );

    expect(result).toEqual({
      chatHistory: mockChatHistory,
      compactionIndex: null,
      wasCompacted: false,
    });
  });
});
