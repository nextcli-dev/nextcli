import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions.mjs";

import { services } from "../services/index.js";
import { ToolCall } from "../tools/index.js";
import { logger } from "../util/logger.js";
import { validateContextLength } from "../util/tokenizer.js";

import { handleAutoCompaction } from "./streamChatResponse.autoCompaction.js";
import { StreamCallbacks } from "./streamChatResponse.types.js";
import {
  COMPACTION_NEXT_PROMPT,
  resumeAfterCompaction,
} from "./turnContinuation.js";

export interface CompactionHelperOptions {
  model: ModelConfig;
  llmApi: BaseLlmApi;
  isCompacting: boolean;
  isHeadless: boolean;
  callbacks?: StreamCallbacks;
  systemMessage: string;
  tools?: ChatCompletionTool[];
  /** The turn's controller: Escape stops a compaction as well as the turn */
  abortController?: AbortController;
}

/**
 * What follows the summary in the next request: the user turn that
 * commitCompacted appends. Not built with resumeAfterCompaction, which
 * writes to the history service.
 */
const NEXT_AFTER_SUMMARY: ChatHistoryItem[] = [
  {
    message: { role: "user", content: COMPACTION_NEXT_PROMPT },
    contextItems: [],
  },
];

/** The history service, when the current run has one */
function historyService() {
  const chatHistorySvc = services.chatHistory;
  return typeof chatHistorySvc?.isReady === "function" &&
    chatHistorySvc.isReady()
    ? chatHistorySvc
    : undefined;
}

/**
 * Makes a compacted history the conversation: writes it to the history
 * service when there is one, then adds the user turn the next call answers.
 * The notices the compaction added to the service (starting, done), the
 * system items past `noticesFrom`, follow the summary; requests leave them
 * out. Earlier notices go with the turns the summary replaced.
 */
function commitCompacted(
  compacted: ChatHistoryItem[],
  noticesFrom: number,
): ChatHistoryItem[] {
  const chatHistorySvc = historyService();
  let base = compacted;
  if (chatHistorySvc) {
    const notices = chatHistorySvc
      .getHistory()
      .slice(noticesFrom)
      .filter((item) => item.message.role === "system");
    chatHistorySvc.setHistory([...compacted, ...notices]);
    base = chatHistorySvc.getHistory();
  }
  return resumeAfterCompaction(base);
}

/** Where the notices a compaction is about to add will start */
function historyLength(): number {
  return historyService()?.getHistory().length ?? 0;
}

/**
 * Handle pre-API auto-compaction if needed
 */
export async function handlePreApiCompaction(
  chatHistory: ChatHistoryItem[],
  options: CompactionHelperOptions,
): Promise<{ chatHistory: ChatHistoryItem[]; wasCompacted: boolean }> {
  const {
    model,
    llmApi,
    isCompacting,
    isHeadless,
    callbacks,
    systemMessage,
    tools,
    abortController,
  } = options;

  if (isCompacting) {
    return { chatHistory, wasCompacted: false };
  }

  const noticesFrom = historyLength();
  const { wasCompacted, chatHistory: preCompactHistory } =
    await handleAutoCompaction(chatHistory, model, llmApi, {
      isHeadless,
      callbacks: {
        onSystemMessage: callbacks?.onSystemMessage,
        onContent: callbacks?.onContent,
      },
      systemMessage,
      tools,
      abortController,
      followedBy: NEXT_AFTER_SUMMARY,
    });

  if (wasCompacted) {
    logger.debug("Pre-API compaction occurred, updating chat history");
    return {
      chatHistory: commitCompacted(preCompactHistory, noticesFrom),
      wasCompacted: true,
    };
  }

  return { chatHistory, wasCompacted: false };
}

/**
 * Validate and handle context overflow after tool execution
 */
export async function handlePostToolValidation(
  toolCalls: ToolCall[],
  chatHistory: ChatHistoryItem[],
  options: CompactionHelperOptions,
): Promise<{ chatHistory: ChatHistoryItem[]; wasCompacted: boolean }> {
  const {
    model,
    llmApi,
    isCompacting,
    isHeadless,
    callbacks,
    systemMessage,
    tools,
    abortController,
  } = options;

  // Never compact inside a compaction
  if (isCompacting || toolCalls.length === 0) {
    return { chatHistory, wasCompacted: false };
  }

  // Get updated history after tool execution
  const chatHistorySvc = services.chatHistory;
  if (
    typeof chatHistorySvc?.isReady === "function" &&
    chatHistorySvc.isReady()
  ) {
    chatHistory = chatHistorySvc.getHistory();
  }

  const SAFETY_BUFFER = 100;
  const postToolValidation = validateContextLength({
    chatHistory,
    model,
    safetyBuffer: SAFETY_BUFFER,
    systemMessage,
    tools,
  });

  // If tool results pushed us over limit, force compaction regardless of threshold
  if (!postToolValidation.isValid) {
    logger.warn("Tool execution caused context overflow, forcing compaction", {
      inputTokens: postToolValidation.inputTokens,
      contextLimit: postToolValidation.contextLimit,
    });

    // Force compaction (compaction now accounts for system message during pruning)
    const noticesFrom = historyLength();
    const {
      wasCompacted,
      chatHistory: compactedHistory,
      error,
    } = await handleAutoCompaction(chatHistory, model, llmApi, {
      isHeadless,
      callbacks: {
        onSystemMessage: callbacks?.onSystemMessage,
        onContent: callbacks?.onContent,
      },
      systemMessage,
      tools,
      abortController,
      followedBy: NEXT_AFTER_SUMMARY,
    });

    // Escape during the compaction: the turn stops, nothing to fix
    if (!wasCompacted && abortController?.signal.aborted) {
      return { chatHistory, wasCompacted: false };
    }

    if (!wasCompacted) {
      // Nothing was written, so the run can be resumed
      logger.error("Failed to compact history after tool execution overflow");
      throw new Error(
        `Context limit exceeded and compaction failed: ${error?.message ?? "no summary"}`,
      );
    }

    // compactChatHistory already checked that this request fits
    logger.info("Compacted after tool overflow");
    return {
      chatHistory: commitCompacted(compactedHistory, noticesFrom),
      wasCompacted: true,
    };
  }

  return { chatHistory, wasCompacted: false };
}

/**
 * Handle normal auto-compaction check at 80% threshold
 */
export async function handleNormalAutoCompaction(
  chatHistory: ChatHistoryItem[],
  shouldContinue: boolean,
  options: CompactionHelperOptions,
): Promise<{ chatHistory: ChatHistoryItem[]; wasCompacted: boolean }> {
  const {
    model,
    llmApi,
    isCompacting,
    isHeadless,
    callbacks,
    systemMessage,
    tools,
    abortController,
  } = options;

  // Never compact inside a compaction
  if (isCompacting || !shouldContinue) {
    return { chatHistory, wasCompacted: false };
  }

  const chatHistorySvc = services.chatHistory;
  if (
    typeof chatHistorySvc?.isReady === "function" &&
    chatHistorySvc.isReady()
  ) {
    chatHistory = chatHistorySvc.getHistory();
  }

  const noticesFrom = historyLength();
  const { wasCompacted, chatHistory: updatedChatHistory } =
    await handleAutoCompaction(chatHistory, model, llmApi, {
      isHeadless,
      callbacks: {
        onSystemMessage: callbacks?.onSystemMessage,
        onContent: callbacks?.onContent,
      },
      systemMessage,
      tools,
      abortController,
      followedBy: NEXT_AFTER_SUMMARY,
    });

  if (wasCompacted) {
    return {
      chatHistory: commitCompacted(updatedChatHistory, noticesFrom),
      wasCompacted: true,
    };
  }

  return { chatHistory, wasCompacted: false };
}
