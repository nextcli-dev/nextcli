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
