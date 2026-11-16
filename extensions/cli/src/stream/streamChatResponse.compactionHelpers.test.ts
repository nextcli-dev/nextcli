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
}));

vi.mock("../util/tokenizer.js", () => ({
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
  const options = (isCompacting: boolean, task?: string) => ({
    model: { name: "m", model: "m", provider: "openai" } as ModelConfig,
    llmApi: {} as BaseLlmApi,
    isCompacting,
    isHeadless: true,
    systemMessage: "System message",
    task,
  });

  async function runBoth(
    chatHistory: ChatHistoryItem[],
    isCompacting: boolean,
    task?: string,
  ) {
    return [
      await handlePostToolValidation(
        toolCalls,
        chatHistory,
        options(isCompacting, task),
      ),
      await handleNormalAutoCompaction(
        chatHistory,
        true,
        options(isCompacting, task),
      ),
    ];
  }

  /** The summary, then the user turns added after it */
  function summaryThen(...userTurns: string[]): ChatHistoryItem[] {
    return [
      ...summary,
      ...userTurns.map((content) => ({
        message: { role: "user" as const, content },
        contextItems: [],
      })),
    ];
  }

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
        chatHistory: summaryThen(COMPACTION_CONTINUE_PROMPT),
        wasCompacted: true,
      });
    }
    expect(compactChatHistory).toHaveBeenCalledTimes(2);
    // The summary they compacted into is left as it was
    expect(summary).toHaveLength(1);
  });

  it("repeat the run's prompt in the user turn", async () => {
    for (const result of await runBoth(longHistory, false, "Review it")) {
      expect(result.chatHistory).toEqual(
        summaryThen(
          `${COMPACTION_CONTINUE_PROMPT} The task, as first given:\n\nReview it`,
        ),
      );
    }
  });

  it("compact before a call into the summary and a user turn", async () => {
    const result = await handlePreApiCompaction(longHistory, options(false));

    expect(result).toEqual({
      chatHistory: summaryThen(COMPACTION_CONTINUE_PROMPT),
      wasCompacted: true,
    });
  });

  it("ask a last call for its answer again after compacting before it", async () => {
    const result = await handlePreApiCompaction(longHistory, {
      ...options(false),
      finalAnswerPrompt: "Give your final answer now.",
    });

    expect(result.chatHistory).toEqual(
      summaryThen(COMPACTION_CONTINUE_PROMPT, "Give your final answer now."),
    );
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
});
