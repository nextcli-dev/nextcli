import type { ChatHistoryItem, PromptLog } from "core";
import { renderChatMessage } from "core/util/messageContent";

/** Why a model call ended without an answer */
export type NoAnswerReason =
  /** The output cap was spent, usually on thinking */
  | "length"
  /** The stream closed without a finish reason */
  | "incomplete"
  /** The model stopped, or the provider didn't say why */
  | "stop";

export interface NoAnswerNotice {
  kind: "no-answer";
  reason: NoAnswerReason;
  outputTokens?: number;
}

/** Sent by "Ask for the answer"; the CLI sends the same text in this case */
export const EMPTY_ANSWER_PROMPT =
  "Your last reply was empty. Write your final answer now.";

/**
 * Returns a notice when the model call that just finished wrote no answer
 * and called no tool, for example when a reasoning model spent its output
 * on thinking. Without it the turn ends on a "Thought for..." block that
 * looks as if the answer were inside it.
 */
export function getNoAnswerNotice(
  history: ChatHistoryItem[],
  promptLog: PromptLog,
): NoAnswerNotice | undefined {
  // The call's output is everything after the last user or tool message
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    const message = item.message;
    if (message.role === "user" || message.role === "tool") {
      break;
    }
    if (message.role !== "assistant") {
      continue;
    }
    if (
      renderChatMessage(message).trim() ||
      message.toolCalls?.length ||
      item.toolCallStates?.length
    ) {
      return undefined;
    }
  }

  const reason: NoAnswerReason =
    promptLog.finishReason === "length"
      ? "length"
      : promptLog.streamEndedWithoutFinish
        ? "incomplete"
        : "stop";
  return {
    kind: "no-answer",
    reason,
    ...(promptLog.outputTokens !== undefined && {
      outputTokens: promptLog.outputTokens,
    }),
  };
}

/** The notice text for each reason */
export function noAnswerText(notice: NoAnswerNotice): string {
  switch (notice.reason) {
    case "length": {
      const tokens =
        notice.outputTokens === undefined
          ? "all its output tokens"
          : `all its output tokens (${notice.outputTokens})`;
      return `The model used ${tokens} before writing an answer. Raise the output limit (maxTokens) for this model.`;
    }
    case "incomplete":
      return "The model's response ended without an answer. The provider closed the stream before the model finished.";
    case "stop":
      return "The model ended its turn without writing an answer.";
  }
}
