import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import { ChatCompletionTool } from "openai/resources.mjs";

import {
  describeFit,
  fitHistory,
  REQUEST_SAFETY_BUFFER,
} from "./fitHistory.js";
import {
  requestTools,
  streamChatResponse,
} from "./stream/streamChatResponse.js";
import { StreamCallbacks } from "./stream/streamChatResponse.types.js";
import { traceEnabled, traceEvent } from "./trace/trace.js";
import { logger } from "./util/logger.js";
import {
  countChatHistoryTokens,
  countText,
  countToolDefinitionTokens,
  countTotalInputTokens,
  getModelContextLimit,
  getModelMaxTokens,
  historySentToModel,
  validateContextLength,
} from "./util/tokenizer.js";

// Buffer cap/ratio for auto-compaction threshold calculation
export const AUTO_COMPACT_BUFFER_CAP = 15_000;
export const AUTO_COMPACT_BUFFER_RATIO = 0.8;

export interface CompactionResult {
  compactedHistory: ChatHistoryItem[];
  compactionIndex: number;
  compactionContent: string;
  /** Earlier messages the summary request had no room for; not in the summary */
  omittedMessages: number;
  /** Tool outputs cut to their start in the summary request */
  shortenedOutputs: number;
}

export interface CompactionCallbacks {
  onStreamContent?: (content: string) => void;
  onStreamComplete?: () => void;
  onError?: (error: Error) => void;
}

export interface CompactionOptions {
  callbacks?: CompactionCallbacks;
  abortController?: AbortController;
  /** The system prompt the summary request goes with; the current one by default */
  systemMessage?: string;
  /** The next request's tools; a normal request's by default */
  tools?: ChatCompletionTool[];
  /**
   * What follows the summary in the next request: the continue prompt in the
   * agent loop, or the person's message before a TUI send. None by default.
   */
  followedBy?: ChatHistoryItem[];
  /** What started it, for the trace; the /compact command by default */
  trigger?: "auto" | "manual";
}

// A summary shorter than this can't carry the work forward
const MIN_SUMMARY_TOKENS = 1_000;
// The highest max_tokens a summary is sent with, the same as a final answer's
// (FINAL_ANSWER_TOKENS)
const MAX_CAPPED_SUMMARY_TOKENS = 16_000;
// Message overhead of the summary item
const SUMMARY_ITEM_TOKENS = 10;

/** The request after the summary, which the summary must fit */
interface NextRequest {
  systemMessage: string;
  tools: ChatCompletionTool[];
  followedBy: ChatHistoryItem[];
}

const COMPACTION_PROMPT =
  "Please provide a concise summary of our conversation so far, capturing the key context, decisions made, and current state. Format this as a single comprehensive message that preserves all important information needed to continue our work. You do not need to recap the system message, as this will remain. Make sure it is clear what the current stream of work was at the very end prior to compaction so that you can continue exactly where you left off without missing any information.";

/** The system prompt for the current mode */
export async function currentSystemMessage(): Promise<string> {
  // Imported here: services import this module
  const { services } = await import("./services/index.js");
  return services.systemMessage.getSystemMessage(
    services.toolPermissions.getState().currentMode,
  );
}

/** The tools a normal request would carry now */
export async function currentRequestTools(
  model: ModelConfig,
): Promise<ChatCompletionTool[]> {
  const { services } = await import("./services/index.js");
  return requestTools(model, services.toolPermissions.isHeadless());
}

/**
 * Tokens the next request leaves for the summary: the window less the answer
 * reserve, the safety buffer, the system prompt, the tools and what follows
 */
function roomForSummary(model: ModelConfig, next: NextRequest): number {
  const rest = countTotalInputTokens({
    chatHistory: next.followedBy,
    systemMessage: next.systemMessage,
    tools: next.tools,
    model,
  });
  return (
    getModelContextLimit(model) -
    getModelMaxTokens(model) -
    REQUEST_SAFETY_BUFFER -
    rest -
    SUMMARY_ITEM_TOKENS
  );
}

/** The error for no room, with the sizes that fill the window */
function noRoomForSummary(
  model: ModelConfig,
  next: NextRequest,
  room: number,
): string {
  const tokens = (n: number) => `${n.toLocaleString()} tokens`;
  const parts = [
    `the system prompt (${tokens(countText(next.systemMessage))})`,
    next.tools.length > 0 &&
      `the tools (${tokens(countToolDefinitionTokens(next.tools))})`,
    next.followedBy.length > 0 &&
      `what follows the summary (${tokens(countChatHistoryTokens(next.followedBy, model))})`,
    `the room kept for the answer (${tokens(getModelMaxTokens(model))})`,
  ].filter((part): part is string => typeof part === "string");
  return `Can't compact: ${parts.join(", ")} leave ${tokens(Math.max(room, 0))} of the ${tokens(getModelContextLimit(model))} window for a summary, less than the ${tokens(MIN_SUMMARY_TOKENS)} one needs. The conversation was left as it is. Raise contextLength, lower maxTokens or turn off tools you don't need.`;
}

/** The model with its answer capped at maxTokens */
function withAnswerCap(model: ModelConfig, maxTokens: number): ModelConfig {
  const { reasoningBudgetTokens, ...options } =
    model.defaultCompletionOptions ?? {};
  return {
    ...model,
    defaultCompletionOptions: {
      ...options,
      maxTokens,
      // A thinking budget must stay below max_tokens
      ...(reasoningBudgetTokens !== undefined &&
        reasoningBudgetTokens < maxTokens && { reasoningBudgetTokens }),
    },
  };
}

/** The error for a summary request that can't fit: the kept parts and their sizes */
function summaryRequestTooLong(
  history: ChatHistoryItem[],
  model: ModelConfig,
  detail?: string,
): string {
  const size = (items: ChatHistoryItem[]) =>
    `${countChatHistoryTokens(items, model).toLocaleString()} tokens`;
  const newest = history.findLastIndex((item) => item.message.role === "user");
  const parts = [
    history[0]?.conversationSummary !== undefined &&
      `the previous summary (${size(history.slice(0, 1))})`,
    newest >= 0 && `the newest request (${size([history[newest]])})`,
    newest < history.length - 1 &&
      `the last step (${size(history.slice(newest + 1))})`,
  ].filter((part): part is string => typeof part === "string");
  const kept =
    parts.length > 1
      ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
      : (parts[0] ?? "the history");
  return `Can't compact: even with tool outputs shortened and earlier messages left out, ${kept} don't fit beside the system prompt and the room kept for the answer (${detail}). The conversation was left as it is. Raise contextLength, lower maxTokens or start a new session.`;
}

/**
 * Compacts a chat history into a summarized form
 * @param chatHistory The current chat history to compact
 * @param model The model configuration
 * @param llmApi The LLM API instance
 * @param options Callbacks, the abort controller, and the request after the summary
 * @returns The compacted history with compaction index
 */
export async function compactChatHistory(
  chatHistory: ChatHistoryItem[],
  model: ModelConfig,
  llmApi: BaseLlmApi,
  options?: CompactionOptions,
): Promise<CompactionResult> {
  const { callbacks, abortController } = options || {};
  const systemMessage =
    options?.systemMessage ?? (await currentSystemMessage());
  const next: NextRequest = {
    systemMessage,
    tools: options?.tools ?? (await currentRequestTools(model)),
    followedBy: options?.followedBy ?? [],
  };
  // NEXTCLI_TRACE: one context.compaction event per attempt, counts only. The
  // before count is the one the auto trigger compares to its threshold.
  const startedAt = Date.now();
  const tokensBefore = traceEnabled()
    ? countTotalInputTokens({
        chatHistory,
        systemMessage: next.systemMessage,
        tools: next.tools,
        model,
      })
    : undefined;
  const traceCompaction = (
    outcome: "compacted" | "failed" | "cancelled",
    result?: CompactionResult,
  ) => {
    if (tokensBefore === undefined) {
      return;
    }
    traceEvent(
      "context.compaction",
      {
        trigger: options?.trigger ?? "manual",
        outcome,
        tokensBefore,
        ...(result && {
          tokensAfter: countTotalInputTokens({
            chatHistory: result.compactedHistory,
            systemMessage: next.systemMessage,
            tools: next.tools,
            model,
          }),
          omittedMessages: result.omittedMessages,
          shortenedOutputs: result.shortenedOutputs,
        }),
      },
      { ts: startedAt, dur: Date.now() - startedAt },
    );
  };
  const fail = (message: string): never => {
    const error = new Error(message);
    traceCompaction("failed");
    logger.error("Compaction failed", error);
    callbacks?.onError?.(error);
    throw error;
  };

  // The summary replaces the session, so it must fit the next request: that
  // request's room caps the summary's length
  const room = roomForSummary(model, next);
  if (room < MIN_SUMMARY_TOKENS) {
    fail(noRoomForSummary(model, next, room));
  }
  const summaryModel =
    room < getModelMaxTokens(model)
      ? withAnswerCap(model, Math.min(room, MAX_CAPPED_SUMMARY_TOKENS))
      : model;

  // Create a prompt to summarize the conversation
  const compactionPrompt: ChatHistoryItem = {
    message: {
      role: "user" as const,
      content: COMPACTION_PROMPT,
    },
    contextItems: [],
  };

  // The same check the summary request passes (it has no tools). The
  // instruction is counted but never kept as a turn.
  const validate = (history: ChatHistoryItem[]) =>
    validateContextLength({
      chatHistory: [...history, compactionPrompt],
      model: summaryModel,
      systemMessage,
      safetyBuffer: REQUEST_SAFETY_BUFFER,
    });
  const fitted = fitHistory(
    historySentToModel(chatHistory),
    (history) => validate(history).isValid,
  );
  if (!fitted.fits) {
    fail(
      summaryRequestTooLong(
        fitted.history,
        model,
        validate(fitted.history).error,
      ),
    );
  }
  if (fitted.removed > 0 || fitted.shortened > 0) {
    logger.warn(`Compaction input too long: ${describeFit(fitted)}`);
  }
  const historyForCompaction = [...fitted.history, compactionPrompt];

  // Stream the compaction response (service drives updates; this collects content locally)
  const controller = abortController || new AbortController();

  let compactionContent = "";
  const streamCallbacks: StreamCallbacks = {
    onContent: (content: string) => {
      compactionContent += content;
      callbacks?.onStreamContent?.(content);
    },
    onContentComplete: () => {
      callbacks?.onStreamComplete?.();
    },
  };

  try {
    // With the system message it was fit to: this turn's, not one read
    // again from files the agent may have edited since
    await streamChatResponse(
      historyForCompaction,
      summaryModel,
      llmApi,
      controller,
      streamCallbacks,
      true,
      undefined,
      systemMessage,
    );

    // An aborted stream returns its partial text: never keep it
    if (controller.signal.aborted) {
      const cancelled = new Error("Compaction cancelled");
      cancelled.name = "AbortError";
      throw cancelled;
    }

    // A stream that ends without text gives no summary
    if (!compactionContent.trim()) {
      throw new Error(
        "The model returned an empty summary, so the conversation was left as it is.",
      );
    }

    // The system prompt isn't part of the history (role:"system" items are
    // TUI notices), so the summary is the whole compacted history
    const compactionMessage: ChatHistoryItem = {
      message: {
        role: "assistant",
        content: compactionContent,
      },
      contextItems: [],
      conversationSummary: compactionContent,
    };

    // Catches a provider that ignores max_tokens, or estimate drift. Callers
    // write only what this returns.
    const nextCheck = validateContextLength({
      chatHistory: [compactionMessage, ...next.followedBy],
      model,
      systemMessage,
      tools: next.tools,
      safetyBuffer: REQUEST_SAFETY_BUFFER,
    });
    if (!nextCheck.isValid) {
      throw new Error(
        `The summary (${countChatHistoryTokens([compactionMessage], model).toLocaleString()} tokens) doesn't fit the request after it (${nextCheck.error}), so the conversation was left as it is.`,
      );
    }

    const result = {
      compactedHistory: [compactionMessage],
      compactionContent,
      compactionIndex: 0,
      omittedMessages: fitted.removed,
      shortenedOutputs: fitted.shortened,
    };
    traceCompaction("compacted", result);
    return result;
  } catch (error) {
    traceCompaction(isCompactionAborted(error) ? "cancelled" : "failed");
    if (!isCompactionAborted(error)) {
      logger.error("Compaction failed", error);
      callbacks?.onError?.(error as Error);
    }
    throw error;
  }
}

/**
 * Finds the compaction index in a chat history
 * @param chatHistory The chat history to search
 * @returns The index of the compaction message, or null if not found
 */
export function findCompactionIndex(
  chatHistory: ChatHistoryItem[],
): number | null {
  const compactedIndex = chatHistory.findIndex(
    (item) => item.conversationSummary !== undefined,
  );
  return compactedIndex === -1 ? null : compactedIndex;
}

/**
 * The notice for a finished compaction, with what didn't fit the summary
 * request (it is in neither the summary nor the session)
 */
export function compactionDoneMessage(
  result: Pick<CompactionResult, "omittedMessages" | "shortenedOutputs">,
  auto = false,
): string {
  const done = `Chat history ${auto ? "auto-" : ""}compacted successfully.`;
  const lost = describeFit({
    removed: result.omittedMessages,
    shortened: result.shortenedOutputs,
  });
  return lost
    ? `${done} To fit the summary request, ${lost}. What was cut isn't in the summary.`
    : done;
}

/** Whether an error is a compaction the user cancelled */
export function isCompactionAborted(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Gets the history to send to the LLM, taking compaction into account
 * @param fullHistory The complete chat history
 * @param compactionIndex The index of the compaction message, if any
 * @returns The history to send to the LLM
 */
export function getHistoryForLLM(
  fullHistory: ChatHistoryItem[],
  compactionIndex: number | null,
): ChatHistoryItem[] {
  if (compactionIndex === null || compactionIndex >= fullHistory.length) {
    return fullHistory;
  }
  return fullHistory.slice(compactionIndex);
}

/**
 * Parameters for auto-compaction check
 */
export interface AutoCompactParams {
  chatHistory: ChatHistoryItem[];
  model: ModelConfig;
  systemMessage?: string;
  tools?: ChatCompletionTool[];
}

/**
 * Get a descriptive message for auto-compaction that shows the context limit
 * @param model The model configuration
 * @returns A descriptive message explaining why compaction is needed
 */
export function getAutoCompactMessage(model: ModelConfig): string {
  const limit = getModelContextLimit(model);
  return `Approaching context limit (${(limit / 1000).toFixed(0)}K tokens). Auto-compacting chat history...`;
}

/**
 * The legacy auto-compaction threshold. The UI reads this; it does not throw.
 * `shouldAutoCompact` still throws when the threshold is not positive.
 */
export function autoCompactThreshold(model: ModelConfig): {
  contextLimit: number;
  maxTokens: number;
  compactionBuffer: number;
  compactionThreshold: number;
} {
  const contextLimit = getModelContextLimit(model);
  const maxTokens = getModelMaxTokens(model);
  const ratioCompactionBuffer = Math.ceil(
    (1 - AUTO_COMPACT_BUFFER_RATIO) * (contextLimit - maxTokens),
  );
  const safeCompactionBuffer = Math.max(maxTokens, ratioCompactionBuffer);
  // At most half the room left after the reserve, so a small window with a
  // large max_tokens (8K of 16K) still gets a positive threshold
  const compactionBuffer = Math.min(
    safeCompactionBuffer,
    AUTO_COMPACT_BUFFER_CAP,
    Math.floor((contextLimit - maxTokens) / 2),
  );
  return {
    contextLimit,
    maxTokens,
    compactionBuffer,
    compactionThreshold: contextLimit - maxTokens - compactionBuffer,
  };
}

/**
 * Check if the chat history exceeds the auto-compact threshold.
 * Accounts for system message and tool definitions in the calculation.
 * @param params Object containing chatHistory, model, optional systemMessage, and optional tools
 * @returns Whether auto-compacting should be triggered
 */
export function shouldAutoCompact(params: AutoCompactParams): boolean {
  const { chatHistory, model, systemMessage, tools } = params;

  const inputTokens = countTotalInputTokens({
    chatHistory,
    systemMessage,
    tools,
    model,
  });
  const { contextLimit, maxTokens, compactionBuffer, compactionThreshold } =
    autoCompactThreshold(model);

  if (compactionThreshold <= 0) {
    throw new Error(
      `max_tokens (${maxTokens}) leaves no room for input in a ${contextLimit}-token context window. Lower maxTokens or raise contextLength in your configuration.`,
    );
  }

  const toolTokens = tools ? countToolDefinitionTokens(tools) : 0;
  const systemTokens = systemMessage ? countText(systemMessage) : 0;
  const shouldCompact = inputTokens >= compactionThreshold;

  logger.debug("Context usage check", {
    inputTokens,
    historyTokens: countChatHistoryTokens(chatHistory, model),
    systemTokens,
    toolTokens,
    contextLimit,
    maxTokens,
    reservedForOutput: maxTokens,
    compactionBuffer,
    compactionThreshold,
    shouldCompact,
  });

  return shouldCompact;
}
