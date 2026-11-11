/**
 * How an OpenAI-compatible stream ended, read from its raw chunks. A
 * reasoning model can spend its output cap on thinking, or a gateway can
 * close the stream early, and either one leaves a turn with no answer. This
 * is what lets the GUI say which happened.
 */
export interface StreamEnd {
  /** The last non-empty finish_reason seen */
  finishReason?: string;
  /** usage.completion_tokens from the usage chunk, thinking included */
  outputTokens?: number;
}

/** Adds the finish reason and output tokens a raw stream chunk reports. */
export function readStreamEnd(
  streamEnd: StreamEnd,
  chunk: {
    choices?: { finish_reason?: string | null }[];
    usage?: { completion_tokens?: number } | null;
  },
): void {
  const finishReason = chunk.choices?.[0]?.finish_reason;
  if (finishReason) {
    streamEnd.finishReason = finishReason;
  }
  const outputTokens = chunk.usage?.completion_tokens;
  if (typeof outputTokens === "number") {
    streamEnd.outputTokens = outputTokens;
  }
}
