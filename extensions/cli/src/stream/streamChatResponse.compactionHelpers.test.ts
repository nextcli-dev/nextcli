import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import { convertToUnifiedHistory } from "core/util/messageConversion.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolCall } from "../tools/index.js";
import { validateContextLength } from "../util/tokenizer.js";

import { handleAutoCompaction } from "./streamChatResponse.autoCompaction.js";
import {
  handleNormalAutoCompaction,
  handlePostToolValidation,
} from "./streamChatResponse.compactionHelpers.js";

vi.mock("./streamChatResponse.autoCompaction.js", () => ({
  handleAutoCompaction: vi.fn((chatHistory) =>
    Promise.resolve({ chatHistory, wasCompacted: true }),
  ),
}));

// Always over the limit, so only the isCompacting guard can stop a compaction
vi.mock("../util/tokenizer.js", () => ({
  validateContextLength: vi.fn(() => ({
    isValid: false,
    inputTokens: 200_000,
    contextLimit: 100_000,
  })),
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

describe("compaction helpers inside a compaction", () => {
  const chatHistory = convertToUnifiedHistory([
    { role: "user", content: "Summarize" },
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not compact after tool calls", async () => {
    const result = await handlePostToolValidation(
      toolCalls,
      chatHistory,
      options(true),
    );

    expect(result.wasCompacted).toBe(false);
    expect(handleAutoCompaction).not.toHaveBeenCalled();
  });

  it("does not auto-compact", async () => {
    const result = await handleNormalAutoCompaction(
      chatHistory,
      true,
      options(true),
    );

    expect(result.wasCompacted).toBe(false);
    expect(handleAutoCompaction).not.toHaveBeenCalled();
  });

  it("still compacts a normal turn", async () => {
    // Over the limit before the compaction, under it after
    vi.mocked(validateContextLength)
      .mockReturnValueOnce({
        isValid: false,
        inputTokens: 200_000,
        contextLimit: 100_000,
      })
      .mockReturnValueOnce({
        isValid: true,
        inputTokens: 10_000,
        contextLimit: 100_000,
      });

    const afterTools = await handlePostToolValidation(
      toolCalls,
      chatHistory,
      options(false),
    );
    const normal = await handleNormalAutoCompaction(
      chatHistory,
      true,
      options(false),
    );

    expect(afterTools.wasCompacted).toBe(true);
    expect(normal.wasCompacted).toBe(true);
    expect(handleAutoCompaction).toHaveBeenCalledTimes(2);
  });
});
