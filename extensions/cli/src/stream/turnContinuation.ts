import type { ChatHistoryItem } from "core/index.js";

import { logger } from "../util/logger.js";

import { addUserMessage } from "./streamChatResponse.helpers.js";

/** Sent once when a run that must answer ends a turn with nothing to say. */
export const EMPTY_ANSWER_PROMPT =
  "Your last reply was empty. Write your final answer now.";

// Set by `cn -p --format json`: stdout must carry an answer, and nobody is
// there to ask for one.
let answerRequired = false;

export function requireFinalAnswer(required: boolean): void {
  answerRequired = required;
}

/** How the last model call ended, from its final stream chunk. */
let lastCallEnd: { finishReason?: string; outputTokens?: number } = {};

/** Notes the finish reason and output tokens a stream chunk reports. */
export function recordCallEnd(chunk: {
  choices?: { finish_reason?: string | null }[];
  usage?: { completion_tokens?: number } | null;
}): void {
  const finishReason = chunk.choices?.[0]?.finish_reason;
  if (finishReason) {
    lastCallEnd = { ...lastCallEnd, finishReason };
  }
  if (chunk.usage?.completion_tokens !== undefined) {
    lastCallEnd = {
      ...lastCallEnd,
      outputTokens: chunk.usage.completion_tokens,
    };
  }
}

/** Forgets the previous call, before a new one starts. */
export function resetCallEnd(): void {
  lastCallEnd = {};
}

/**
 * Why the last call gave no answer, when it ran out of output tokens: the
 * provider's cap can be spent on thinking before any text is written.
 */
export function outputCapMessage(): string | undefined {
  if (lastCallEnd.finishReason !== "length") {
    return undefined;
  }
  const tokens =
    lastCallEnd.outputTokens === undefined
      ? "all its output tokens"
      : `all its output tokens (${lastCallEnd.outputTokens})`;
  return `The model used ${tokens} before writing an answer. Raise the output limit (maxTokens) for this model.`;
}

/** What one turn of the agent loop carries into the next. */
export interface TurnState {
  /** Compaction ran during this turn */
  compacted: boolean;
  /** The model was already asked for a missing answer */
  askedForAnswer: boolean;
}

/**
 * Decides whether the loop runs again after a model response with no tool
 * calls left to run. It runs again after compaction ("continue"), or once
 * when an answer is required and the model wrote nothing.
 */
export function continueAfterResponse(
  turn: TurnState,
  response: {
    shouldContinue: boolean;
    content: string;
    chatHistory: ChatHistoryItem[];
  },
): { continue: boolean; chatHistory: ChatHistoryItem[] } {
  const { shouldContinue, content, chatHistory } = response;
  if (shouldContinue) {
    return { continue: true, chatHistory };
  }
  if (turn.compacted) {
    turn.compacted = false;
    logger.debug(
      "Auto-compaction occurred during this turn - automatically continuing session",
    );
    const history = addUserMessage(chatHistory, "continue");
    logger.debug("Added continuation message after compaction");
    return { continue: true, chatHistory: history };
  }
  if (answerRequired && !content.trim() && !turn.askedForAnswer) {
    turn.askedForAnswer = true;
    logger.debug("Empty final turn, asking for the answer");
    return {
      continue: true,
      chatHistory: addUserMessage(chatHistory, EMPTY_ANSWER_PROMPT),
    };
  }
  return { continue: false, chatHistory };
}
