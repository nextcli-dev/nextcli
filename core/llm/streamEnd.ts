import type { Usage } from "../index.js";

import { type ChatUsage, toUsage } from "./openaiTypeConverters.js";

/**
 * How an OpenAI-compatible stream ended, read from its raw chunks, or from a
 * whole response. A reasoning model can spend its output cap on thinking, or
 * a gateway can close the stream early, and either one leaves a turn with no
 * answer. This is what lets the GUI say which happened.
 */
export interface StreamEnd {
  /** The last non-empty finish_reason seen */
  finishReason?: string;
  /** usage.completion_tokens from the usage chunk, thinking included */
  outputTokens?: number;
  /**
   * The usage the provider reported. Read from the raw chunk, so usage that
   * comes with a reasoning delta, which converts to a thinking message, counts
   */
  usage?: Usage;
}

/** Adds the finish reason and usage a raw stream chunk reports. */
export function readStreamEnd(
  streamEnd: StreamEnd,
  chunk: {
    choices?: { finish_reason?: string | null }[];
    usage?: ChatUsage | null;
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
  if (chunk.usage) {
    streamEnd.usage = toUsage(chunk.usage);
  }
}
