import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions.mjs";
import React from "react";

import {
  compactChatHistory,
  type CompactionResult,
  compactionDoneMessage,
  currentRequestTools,
  currentSystemMessage,
  getAutoCompactMessage,
  isCompactionAborted,
  shouldAutoCompact,
} from "../compaction.js";
import { safeStderr } from "../init.js";
import { formatError } from "../util/formatError.js";
import { logger } from "../util/logger.js";

interface AutoCompactionCallbacks {
  // For streaming mode
  onSystemMessage?: (message: string) => void;
  onContent?: (content: string) => void;

  // For TUI mode
  setMessages?: React.Dispatch<React.SetStateAction<ChatHistoryItem[]>>;
  setChatHistory?: React.Dispatch<React.SetStateAction<ChatHistoryItem[]>>;
  setCompactionIndex?: React.Dispatch<React.SetStateAction<number | null>>;

  // For headless mode - no callbacks needed, just return values
}

interface AutoCompactionOptions {
  isHeadless?: boolean;
  format?: "json";
  callbacks?: AutoCompactionCallbacks;
  systemMessage?: string;
  tools?: ChatCompletionTool[];
  /** Escape aborts it: the summary call stops and the history stays as it was */
  abortController?: AbortController;
  /** What follows the summary in the next request, which it is sized to fit */
  followedBy?: ChatHistoryItem[];
}

/**
 * Notify user about compaction start
 */
function notifyCompactionStart(
  message: string,
  isHeadless: boolean,
  callbacks?: AutoCompactionCallbacks,
) {
  if (isHeadless) return;

  if (callbacks?.onSystemMessage) {
    callbacks.onSystemMessage(message);
  } else if (callbacks?.setMessages) {
    // TUI mode - handled by caller
  }
}

/**
 * Handle successful compaction state updates
 */
function handleCompactionSuccess(
  result: CompactionResult,
  isHeadless: boolean,
  callbacks?: AutoCompactionCallbacks,
) {
  const successMessage = compactionDoneMessage(result, true);

  if (isHeadless) {
    // Headless: report what the summary lost on stderr
    if (result.omittedMessages > 0 || result.shortenedOutputs > 0) {
      safeStderr(`Warning: ${successMessage}\n`);
    }
    return;
  }

  if (callbacks?.onSystemMessage) {
    callbacks.onSystemMessage(successMessage);
  } else if (
    callbacks?.setMessages &&
    callbacks?.setChatHistory &&
    callbacks?.setCompactionIndex
  ) {
    callbacks.setChatHistory(result.compactedHistory);
    callbacks.setCompactionIndex(result.compactionIndex);
    callbacks.setMessages((prev: ChatHistoryItem[]) => [
      ...prev,
      {
        message: {
          role: "system",
          content: successMessage,
        },
        contextItems: [],
      },
    ]);
  }
}

/**
 * Handle compaction error notification
 */
function handleCompactionError(
  error: any,
  isHeadless: boolean,
  callbacks?: AutoCompactionCallbacks,
) {
  const errorMessage = `Auto-compaction error: ${formatError(error)}`;
  logger.error(errorMessage);

  // Headless: report the reason on stderr
  if (isHeadless) {
    safeStderr(`Warning: ${errorMessage}\n`);
    return;
  }

  const warningMessage = `Warning: ${errorMessage}. Continuing without compaction...`;

  if (callbacks?.onSystemMessage) {
    callbacks.onSystemMessage(warningMessage);
  } else if (callbacks?.setMessages) {
    callbacks.setMessages((prev: ChatHistoryItem[]) => [
      ...prev,
      {
        message: {
          role: "system",
          content: warningMessage,
        },
        contextItems: [],
      },
    ]);
  }
}

/**
 * Unified auto-compaction handler for all modes (streaming, TUI, headless)
 * @param chatHistory Current chat history
 * @param model Model configuration
 * @param llmApi LLM API instance
 * @param options Configuration options for different usage contexts
 * @returns Updated chat history and compaction index, or original if no compaction needed
 */
export async function handleAutoCompaction(
  chatHistory: ChatHistoryItem[],
  model: ModelConfig,
  llmApi: BaseLlmApi,
  options: AutoCompactionOptions = {},
): Promise<{
  chatHistory: ChatHistoryItem[];
  compactionIndex: number | null;
  wasCompacted: boolean;
  /** What didn't fit the summary request, when compacted */
  omittedMessages?: number;
  shortenedOutputs?: number;
  /** Why it didn't compact, when it tried and failed */
  error?: Error;
}> {
  const {
    isHeadless = false,
    callbacks,
    abortController,
    followedBy,
  } = options;

  if (!model || abortController?.signal.aborted) {
    return { chatHistory, compactionIndex: null, wasCompacted: false };
  }
  // The trigger counts the request the summary call fills in: the caller's
  // system prompt and tools, else the current ones. Before a user message
  // (the TUI's send, headless before its first turn) callers pass neither,
  // and history alone would come in under the threshold.
  const systemMessage = options.systemMessage ?? (await currentSystemMessage());
  const tools = options.tools ?? (await currentRequestTools(model));
  if (!shouldAutoCompact({ chatHistory, model, systemMessage, tools })) {
    return { chatHistory, compactionIndex: null, wasCompacted: false };
  }

  logger.info(
    `Auto-compaction triggered${isHeadless ? " in headless mode" : ""}`,
  );

  // Notify about compaction start
  notifyCompactionStart(getAutoCompactMessage(model), isHeadless, callbacks);

  try {
    // Compact the history
    const result = await compactChatHistory(chatHistory, model, llmApi, {
      callbacks: isHeadless
        ? undefined
        : {
            onStreamContent: callbacks?.onContent,
            onStreamComplete: () => {},
          },
      systemMessage,
      tools,
      followedBy,
      abortController,
      trigger: "auto",
    });

    // Callers write the result through the history service once this
    // returns; a subagent's compaction must not reach the main session's file

    // Handle success notification
    handleCompactionSuccess(result, isHeadless, callbacks);

    return {
      chatHistory: result.compactedHistory,
      compactionIndex: result.compactionIndex,
      wasCompacted: true,
      omittedMessages: result.omittedMessages,
      shortenedOutputs: result.shortenedOutputs,
    };
  } catch (error: any) {
    // Cancelled by the user: nothing to report, the history is unchanged
    if (isCompactionAborted(error)) {
      logger.info("Auto-compaction cancelled");
      return { chatHistory, compactionIndex: null, wasCompacted: false };
    }
    // Handle error notification
    handleCompactionError(error, isHeadless, callbacks);

    // Continue without compaction on error
    return {
      chatHistory,
      compactionIndex: null,
      wasCompacted: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
