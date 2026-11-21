import type { Usage } from "../index.js";

import {
  type ChatUsage,
  fromResponsesUsage,
  toUsage,
} from "./openaiTypeConverters.js";

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

/**
 * Adds how a Responses API response ended, from the whole response or the
 * one its completed or incomplete event carries. Running out of output
 * tokens is "length", as chat completions report it.
 */
export function readResponseEnd(
  streamEnd: StreamEnd,
  response: {
    status?: string;
    incomplete_details?: { reason?: string } | null;
    usage?: Parameters<typeof fromResponsesUsage>[0] | null;
  },
): void {
  if (response.status === "completed") {
    streamEnd.finishReason = "stop";
  } else if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    streamEnd.finishReason =
      reason === "max_output_tokens" ? "length" : (reason ?? "incomplete");
  }
  if (response.usage) {
    streamEnd.usage = fromResponsesUsage(response.usage);
    streamEnd.outputTokens = response.usage.output_tokens;
  }
}
