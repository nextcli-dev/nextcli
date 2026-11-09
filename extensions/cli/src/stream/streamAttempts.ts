import { encode } from "gpt-tokenizer";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.mjs";

import type { StreamAttemptHooks } from "../util/exponentialBackoff.js";

import { recordStreamTelemetry } from "./streamChatResponse.helpers.js";

/** Text the model generated in one chunk: answer, reasoning, tool arguments */
function generatedText(chunk: ChatCompletionChunk): string {
  const delta: any = chunk.choices?.[0]?.delta ?? {};
  const toolArgs = (delta.tool_calls ?? [])
    .map((call: any) => call.function?.arguments ?? "")
    .join("");
  return [
    delta.content ?? "",
    delta.reasoning_content ?? "",
    delta.reasoning ?? "",
    toolArgs,
  ].join("");
}

function hasGeneratedToken(chunk: ChatCompletionChunk): boolean {
  const delta = chunk.choices?.[0]?.delta;
  return !!(delta && (delta.content || delta.tool_calls));
}

/**
 * Follows the attempts of one model call that may be retried.
 *
 * - The first token is stamped when it arrives, not when the finished
 *   attempt is released, so time to first token stays what it says.
 * - An attempt that fails after producing tokens may already be billed. Its
 *   usage is recorded like a finished call, so --max-cost and the token limits
 *   see it: the provider's usage when it arrived, otherwise an estimate.
 */
export function trackStreamAttempts(options: {
  requestStartTime: number;
  model: any;
  tools?: any[];
  estimateInputTokens: () => number;
}): StreamAttemptHooks<ChatCompletionChunk> & {
  firstTokenAt: () => number | undefined;
} {
  let firstTokenAt: number | undefined;

  return {
    firstTokenAt: () => firstTokenAt,
    onChunk: (chunk) => {
      if (firstTokenAt === undefined && hasGeneratedToken(chunk)) {
        firstTokenAt = Date.now();
      }
    },
    onDiscardedAttempt: (chunks) => {
      firstTokenAt = undefined;
      const usage = [...chunks].reverse().find((chunk) => chunk.usage)?.usage;
      recordStreamTelemetry({
        requestStartTime: options.requestStartTime,
        responseEndTime: Date.now(),
        inputTokens: usage?.prompt_tokens ?? options.estimateInputTokens(),
        outputTokens:
          usage?.completion_tokens ??
          encode(chunks.map(generatedText).join("")).length,
        model: options.model,
        tools: options.tools,
        fullUsage: usage,
        call: { discarded: true },
      });
    },
  };
}
