import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import { encode } from "gpt-tokenizer";
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
import { logger } from "./util/logger.js";
import {
  countChatHistoryTokens,
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
  /** Tool outputs the summary request held only the start of */
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
  /** The tools the request after the summary carries; a normal request's by default */
  tools?: ChatCompletionTool[];
  /**
   * What follows the summary in that request: the continue prompt in the
   * agent loop, the person's message before a TUI send. Nothing by default.
   */
  followedBy?: ChatHistoryItem[];
}

// A summary shorter than this can't carry the work forward
const MIN_SUMMARY_TOKENS = 1_000;
// The highest explicit max_tokens a summary is sent with, the same ceiling a
// run's final answer has (FINAL_ANSWER_TOKENS)
const MAX_CAPPED_SUMMARY_TOKENS = 16_000;
// The summary item's own message overhead
const SUMMARY_ITEM_TOKENS = 10;

/** The request after the summary: what it sizes the summary for */
interface NextRequest {
  systemMessage: string;
  tools: ChatCompletionTool[];
  followedBy: ChatHistoryItem[];
}

const COMPACTION_PROMPT =
  "Please provide a concise summary of our conversation so far, capturing the key context, decisions made, and current state. Format this as a single comprehensive message that preserves all important information needed to continue our work. You do not need to recap the system message, as this will remain. Make sure it is clear what the current stream of work was at the very end prior to compaction so that you can continue exactly where you left off without missing any information.";

/** The system prompt for the current mode */
async function currentSystemMessage(): Promise<string> {
  // Imported here: services import this module
  const { services } = await import("./services/index.js");
  return services.systemMessage.getSystemMessage(
    services.toolPermissions.getState().currentMode,
  );
}

/** The tools a normal request would carry now */
async function currentRequestTools(
  model: ModelConfig,
): Promise<ChatCompletionTool[]> {
  const { services } = await import("./services/index.js");
  return requestTools(model, services.toolPermissions.isHeadless());
}

/**
 * The tokens the request after the summary leaves for it: the window less
 * the room kept for the answer, the safety buffer, the system prompt, the
 * tools and what follows the summary
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

/** Why there's no room for a summary, with the sizes that take the window */
function noRoomForSummary(
  model: ModelConfig,
  next: NextRequest,
  room: number,
): string {
  const tokens = (n: number) => `${n.toLocaleString()} tokens`;
  const parts = [
    `the system prompt (${tokens(encode(next.systemMessage).length)})`,
    next.tools.length > 0 &&
      `the tools (${tokens(countToolDefinitionTokens(next.tools))})`,
    next.followedBy.length > 0 &&
      `what follows the summary (${tokens(countChatHistoryTokens(next.followedBy, model))})`,
    `the room kept for the answer (${tokens(getModelMaxTokens(model))})`,
  ].filter((part): part is string => typeof part === "string");
  return `Can't compact: ${parts.join(", ")} leave ${tokens(Math.max(room, 0))} of the ${tokens(getModelContextLimit(model))} window for a summary, less than the ${tokens(MIN_SUMMARY_TOKENS)} one needs. The conversation was left as it is. Raise contextLength, lower maxTokens or turn off tools you don't need.`;
}

/** The model with its answer capped, so a summary fits the request after it */
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

/** Why a summary request can't be made: the parts that are never left out, and their sizes */
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
 * @param options Optional configuration including callbacks, abort controller, and system message tokens
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
  const fail = (message: string): never => {
    const error = new Error(message);
    logger.error("Compaction failed", error);
    callbacks?.onError?.(error);
    throw error;
  };

  // The summary replaces the session, so it has to fit the request after
  // it: that request's room caps the summary call's answer. Nothing is
  // written before the result is checked below.
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

  // The check the summary request itself passes (it has no tools), so what
  // fits here is what gets sent. The instruction is counted, never a turn to
  // keep, and the request isn't fitted again on the way out.
  const validate = (history: ChatHistoryItem[]) =>
    validateContextLength({
      chatHistory: [...history, compactionPrompt],
      model: summaryModel,
      systemMessage,
      safetyBuffer: REQUEST_SAFETY_BUFFER,
    });
  // Too long to summarize whole: shorten older tool outputs, then leave
  // earlier messages out, so the summary still covers the latest request
  const fitted = fitHistory(
    historySentToModel(chatHistory),
    (history) => validate(history).isValid,
  );
  // The summary replaces the session: fail, and keep the session as it is,
  // rather than summarize less than the newest turn
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
    await streamChatResponse(
      historyForCompaction,
      summaryModel,
      llmApi,
      controller,
      streamCallbacks,
      true,
    );

    // An aborted stream returns what it had so far: never keep a partial summary
    if (controller.signal.aborted) {
      const cancelled = new Error("Compaction cancelled");
      cancelled.name = "AbortError";
      throw cancelled;
    }

    // A provider that ends the stream without text gave no summary
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

    // A provider that ignores max_tokens, or an estimate that drifted: the
    // session stays as it is rather than hold a summary it can't send
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

    return {
      compactedHistory: [compactionMessage],
      compactionContent,
      compactionIndex: 0,
      omittedMessages: fitted.removed,
      shortenedOutputs: fitted.shortened,
    };
  } catch (error) {
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
 * What to tell the person once a compaction is done, including what didn't
 * fit the summary request: it is in neither the summary nor the session
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
  const contextLimit = getModelContextLimit(model);
  const maxTokens = getModelMaxTokens(model);

  // Additional buffer matching the auto-compaction threshold formula
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

  const compactionThreshold = contextLimit - maxTokens - compactionBuffer;

  if (compactionThreshold <= 0) {
    throw new Error(
      `max_tokens (${maxTokens}) leaves no room for input in a ${contextLimit}-token context window. Lower maxTokens or raise contextLength in your configuration.`,
    );
  }

  const toolTokens = tools ? countToolDefinitionTokens(tools) : 0;
  const systemTokens = systemMessage ? encode(systemMessage).length : 0;
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
