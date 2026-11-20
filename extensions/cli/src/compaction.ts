import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import { encode } from "gpt-tokenizer";
import { ChatCompletionTool } from "openai/resources.mjs";

import { streamChatResponse } from "./stream/streamChatResponse.js";
import { StreamCallbacks } from "./stream/streamChatResponse.types.js";
import { logger } from "./util/logger.js";
import {
  countChatHistoryItemTokens,
  countChatHistoryTokens,
  countToolDefinitionTokens,
  countTotalInputTokens,
  getModelContextLimit,
  getModelMaxTokens,
  historySentToModel,
} from "./util/tokenizer.js";

// Buffer cap/ratio for auto-compaction threshold calculation
export const AUTO_COMPACT_BUFFER_CAP = 15_000;
export const AUTO_COMPACT_BUFFER_RATIO = 0.8;

export interface CompactionResult {
  compactedHistory: ChatHistoryItem[];
  compactionIndex: number;
  compactionContent: string;
  /** The oldest messages the summary request had no room for; not in the summary */
  omittedMessages: number;
}

export interface CompactionCallbacks {
  onStreamContent?: (content: string) => void;
  onStreamComplete?: () => void;
  onError?: (error: Error) => void;
}

export interface CompactionOptions {
  callbacks?: CompactionCallbacks;
  abortController?: AbortController;
  systemMessageTokens?: number;
}

const COMPACTION_PROMPT =
  "Please provide a concise summary of our conversation so far, capturing the key context, decisions made, and current state. Format this as a single comprehensive message that preserves all important information needed to continue our work. You do not need to recap the system message, as this will remain. Make sure it is clear what the current stream of work was at the very end prior to compaction so that you can continue exactly where you left off without missing any information.";

const COMPACTION_PROMPT_TOKENS = 150; // rough generous token count of ^

/**
 * Tokens of the system prompt a request is sent with: the given prompt, else
 * the current one for the current mode
 */
export async function countSystemMessageTokens(
  model: ModelConfig,
  systemMessage?: string,
): Promise<number> {
  let prompt = systemMessage;
  if (prompt === undefined) {
    // Imported here: services import this module
    const { services } = await import("./services/index.js");
    prompt = await services.systemMessage.getSystemMessage(
      services.toolPermissions.getState().currentMode,
    );
  }
  return countChatHistoryItemTokens(
    { message: { role: "system", content: prompt }, contextItems: [] },
    model,
  );
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
  // The summary request carries the system prompt too (/compact passes no count)
  const systemMessageTokens =
    options?.systemMessageTokens ?? (await countSystemMessageTokens(model));
  // Create a prompt to summarize the conversation
  const compactionPrompt: ChatHistoryItem = {
    message: {
      role: "user" as const,
      content: COMPACTION_PROMPT,
    },
    contextItems: [],
  };

  const contextLimit = getModelContextLimit(model);
  const maxTokens = getModelMaxTokens(model);

  const availableForInput =
    contextLimit - maxTokens - systemMessageTokens - COMPACTION_PROMPT_TOKENS;

  // Too long to summarize whole: leave the oldest turns out, so the summary
  // still covers the latest request and the work on it. The instruction is
  // only counted here, never a turn to keep, and the request isn't pruned
  // again on the way out.
  const pruned = pruneOldestTurns(
    historySentToModel(chatHistory),
    (history) =>
      countChatHistoryTokens([...history, compactionPrompt], model) <=
      availableForInput,
  );
  // The summary replaces the session: fail, and keep the session as it is,
  // rather than summarize less than the newest turn
  if (!pruned.fits) {
    const error = new Error(
      `The newest turn doesn't fit the ${availableForInput}-token room for a summary request, so the conversation was left as it is. Raise contextLength, lower maxTokens or start a new session.`,
    );
    logger.error("Compaction failed", error);
    callbacks?.onError?.(error);
    throw error;
  }
  if (pruned.removed > 0) {
    logger.warn("Compaction input too long, left the oldest messages out", {
      removed: pruned.removed,
      availableForInput,
    });
  }
  const historyForCompaction = [...pruned.history, compactionPrompt];

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
      model,
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

    return {
      compactedHistory: [compactionMessage],
      compactionContent,
      compactionIndex: 0,
      omittedMessages: pruned.removed,
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

/** Starts the note that stands in for messages left out of a request */
export const PRUNED_HISTORY_NOTE_PREFIX = "[Context note:";

/**
 * The history with a note in front saying how many messages are gone. The
 * note joins a leading user message, so roles still alternate for providers
 * that require it.
 */
function withPrunedNote(
  history: ChatHistoryItem[],
  removed: number,
): ChatHistoryItem[] {
  const note = `${PRUNED_HISTORY_NOTE_PREFIX} ${removed} earlier messages of this conversation were left out to fit the context window. Continue from the messages below.]`;
  const [first, ...rest] = history;
  if (first?.message.role !== "user") {
    return [
      { message: { role: "user", content: note }, contextItems: [] },
      ...history,
    ];
  }
  const content = first.message.content;
  return [
    {
      ...first,
      message: {
        ...first.message,
        content:
          typeof content === "string"
            ? `${note}\n\n${content}`
            : [{ type: "text", text: note }, ...content],
      },
    },
    ...rest,
  ];
}

/**
 * The history without its oldest part: the oldest whole turn (a user message
 * and everything up to the next one) while an older turn than the newest one
 * exists, then the oldest step of the newest turn (an assistant message and
 * its tool results). Never the newest user message or the last step; null
 * when nothing else is left.
 */
function dropOldestPart(history: ChatHistoryItem[]): ChatHistoryItem[] | null {
  if (history.length === 0) {
    return null;
  }
  const isUser = (item: ChatHistoryItem) => item.message.role === "user";
  const nextUser = history.findIndex((item, i) => i > 0 && isUser(item));
  if (nextUser > 0) {
    return history.slice(nextUser);
  }
  // Only the newest turn is left: keep its user message, drop its oldest step
  const stepStart = isUser(history[0]) ? 1 : 0;
  let stepEnd = stepStart + 1;
  while (stepEnd < history.length && history[stepEnd].message.role === "tool") {
    stepEnd++;
  }
  if (stepEnd >= history.length) {
    return null;
  }
  return [...history.slice(0, stepStart), ...history.slice(stepEnd)];
}

/**
 * Leaves the oldest messages out until the history fits, oldest turns first,
 * and puts a note in front saying how many are gone. A tool call keeps its
 * results, the newest user message stays, and so does a leading summary from
 * an earlier compaction: it is the only record of what came before it.
 * Returns the history as given when it fits, else the shortest one with
 * `fits: false` when nothing more can go.
 * @param chatHistory The history to send
 * @param fits Whether a history fits the request
 */
export function pruneOldestTurns(
  chatHistory: ChatHistoryItem[],
  fits: (history: ChatHistoryItem[]) => boolean,
): { history: ChatHistoryItem[]; removed: number; fits: boolean } {
  if (fits(chatHistory)) {
    return { history: chatHistory, removed: 0, fits: true };
  }
  const summary =
    chatHistory[0]?.conversationSummary === undefined
      ? []
      : chatHistory.slice(0, 1);
  const body = chatHistory.slice(summary.length);
  let kept = body;
  let candidate = chatHistory;
  let fitted = false;
  while (!fitted) {
    const next = dropOldestPart(kept);
    if (!next) {
      break;
    }
    kept = next;
    candidate = [
      ...summary,
      ...withPrunedNote(kept, body.length - kept.length),
    ];
    fitted = fits(candidate);
  }
  return {
    history: candidate,
    removed: body.length - kept.length,
    fits: fitted,
  };
}

/**
 * What to tell the person once a compaction is done, including the oldest
 * messages it had no room for: they are in neither the summary nor the session
 */
export function compactionDoneMessage(
  result: Pick<CompactionResult, "omittedMessages">,
  auto = false,
): string {
  const done = `Chat history ${auto ? "auto-" : ""}compacted successfully.`;
  return result.omittedMessages > 0
    ? `${done} The ${result.omittedMessages} oldest messages didn't fit the summary request and aren't in the summary.`
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
