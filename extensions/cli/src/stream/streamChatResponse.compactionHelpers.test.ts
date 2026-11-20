import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import { convertToUnifiedHistory } from "core/util/messageConversion.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { compactChatHistory } from "../compaction.js";
import { ToolCall } from "../tools/index.js";

import {
  handleNormalAutoCompaction,
  handlePostToolValidation,
  handlePreApiCompaction,
} from "./streamChatResponse.compactionHelpers.js";
import { COMPACTION_CONTINUE_PROMPT } from "./turnContinuation.js";

// A history is over the limit while it holds this message. The summary that
// replaces it is under, so each check below decides from the history it gets.
const LONG = "a long tool result";

function isOverLimit(chatHistory: ChatHistoryItem[]): boolean {
  return chatHistory.some((item) => item.message.content === LONG);
}

const summary = convertToUnifiedHistory([
  { role: "assistant", content: "Summary" },
]);

vi.mock("../compaction.js", () => ({
  shouldAutoCompact: vi.fn(({ chatHistory }) => isOverLimit(chatHistory)),
  compactChatHistory: vi.fn(() =>
    Promise.resolve({
      compactedHistory: summary,
      compactionIndex: 0,
      compactionContent: "Summary",
    }),
  ),
  getAutoCompactMessage: vi.fn(() => "Compacting"),
  countSystemMessageTokens: vi.fn(async () => 0),
  isCompactionAborted: (error: Error) => error?.name === "AbortError",
}));

vi.mock("../util/tokenizer.js", () => ({
  historySentToModel: (history: { message: { role: string } }[]) =>
    history.filter((item) => item.message.role !== "system"),
  validateContextLength: vi.fn(({ chatHistory }) =>
    isOverLimit(chatHistory)
      ? {
          isValid: false,
          inputTokens: 200_000,
          contextLimit: 100_000,
          error: "over the limit",
        }
      : { isValid: true, inputTokens: 10_000, contextLimit: 100_000 },
  ),
  countChatHistoryItemTokens: vi.fn(() => 10),
}));

vi.mock("../session.js", () => ({
  updateSessionHistory: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  services: {
    chatHistory: {
      isReady: vi.fn(() => false),
    },
  },
}));

vi.mock("../util/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("compaction helpers", () => {
  const longHistory = convertToUnifiedHistory([
    { role: "user", content: "Review the change" },
    { role: "user", content: LONG },
  ]);
  const shortHistory = convertToUnifiedHistory([
    { role: "user", content: "Review the change" },
  ]);
  const toolCalls = [
    { id: "1", name: "Read", arguments: {}, argumentsStr: "{}" },
  ] as unknown as ToolCall[];
  const options = (isCompacting: boolean) => ({
    model: { name: "m", model: "m", provider: "openai" } as ModelConfig,
    llmApi: {} as BaseLlmApi,
    isCompacting,
    isHeadless: true,
    systemMessage: "System message",
  });

  async function runBoth(
    chatHistory: ChatHistoryItem[],
    isCompacting: boolean,
  ) {
    return [
      await handlePostToolValidation(
        toolCalls,
        chatHistory,
        options(isCompacting),
      ),
      await handleNormalAutoCompaction(
        chatHistory,
        true,
        options(isCompacting),
      ),
    ];
  }

  // The summary, then the user turn the next call answers
  const summaryAndContinue: ChatHistoryItem[] = [
    ...summary,
    {
      message: { role: "user", content: COMPACTION_CONTINUE_PROMPT },
      contextItems: [],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("do not compact inside a compaction, even over the limit", async () => {
    for (const result of await runBoth(longHistory, true)) {
      expect(result).toEqual({ chatHistory: longHistory, wasCompacted: false });
    }
    expect(compactChatHistory).not.toHaveBeenCalled();
  });

  it("compact a normal turn over the limit into the summary and a user turn", async () => {
    // A run calling tools needs a user turn to answer: after the summary
    // alone, AI review run 43834678832 kept reading files and never answered
    for (const result of await runBoth(longHistory, false)) {
      expect(result).toEqual({
        chatHistory: summaryAndContinue,
        wasCompacted: true,
      });
    }
    expect(compactChatHistory).toHaveBeenCalledTimes(2);
    // The summary they compacted into is left as it was
    expect(summary).toHaveLength(1);
  });

  it("compact before a call into the summary and a user turn", async () => {
    const result = await handlePreApiCompaction(longHistory, options(false));

    expect(result).toEqual({
      chatHistory: summaryAndContinue,
      wasCompacted: true,
    });
  });

  it("leave a normal turn under the limit as it is", async () => {
    for (const result of await runBoth(shortHistory, false)) {
      expect(result).toEqual({
        chatHistory: shortHistory,
        wasCompacted: false,
      });
    }
    expect(compactChatHistory).not.toHaveBeenCalled();
  });

  it("stop on Escape during a compaction without failing the turn", async () => {
    const abortController = new AbortController();
    vi.mocked(compactChatHistory).mockImplementation(async () => {
      abortController.abort();
      throw Object.assign(new Error("Compaction cancelled"), {
        name: "AbortError",
      });
    });
    const withController = { ...options(false), abortController };

    // Over the limit after a tool: a failed compaction throws, a cancel doesn't
    const postTool = await handlePostToolValidation(
      toolCalls,
      longHistory,
      withController,
    );
    const preApi = await handlePreApiCompaction(longHistory, withController);

    expect(postTool).toEqual({ chatHistory: longHistory, wasCompacted: false });
    expect(preApi).toEqual({ chatHistory: longHistory, wasCompacted: false });
    // The summary call got the turn's controller; once aborted, none starts
    expect(compactChatHistory).toHaveBeenCalledTimes(1);
    expect(vi.mocked(compactChatHistory).mock.calls[0][3]).toMatchObject({
      abortController,
    });
  });
});
