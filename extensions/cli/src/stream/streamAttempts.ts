import { encode } from "gpt-tokenizer";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.mjs";

import type { StreamAttemptHooks } from "../util/exponentialBackoff.js";

import { ReasoningAccumulator } from "./reasoning.js";
import {
  describeError,
  hasGeneratedToken,
  recordStreamTelemetry,
} from "./streamChatResponse.helpers.js";
import { readCallEnd } from "./turnContinuation.js";

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

/** What a discarded attempt produced before it failed */
function summarizeAttempt(chunks: ChatCompletionChunk[]) {
  const reasoning = new ReasoningAccumulator();
  const toolCalls: string[] = [];
  let contentChars = 0;
  for (const chunk of chunks) {
    const delta: any = chunk.choices?.[0]?.delta ?? {};
    reasoning.add(delta);
    contentChars += delta.content?.length ?? 0;
    for (const call of delta.tool_calls ?? []) {
      if (call.function?.name) toolCalls.push(call.function.name);
    }
  }
  return {
    finishReason: chunks.reduce(readCallEnd, {}).finishReason,
    contentChars,
    reasoningChars: reasoning.chars(),
    toolCalls,
  };
}

/**
 * Follows the attempts of one model call that may be retried.
 *
 * - The first token is stamped when it arrives, not when the finished
 *   attempt is released, so time to first token stays what it says.
 * - An attempt that fails after producing tokens may already be billed. Its
 *   usage is recorded like a finished call, so --max-cost and the token limits
 *   see it: the provider's usage when it arrived, otherwise an estimate. It is
 *   the one record of that attempt, retried or not.
 */
export function trackStreamAttempts(options: {
  requestStartTime: number;
  model: any;
  tools?: any[];
  abortSignal: AbortSignal;
  estimateInputTokens: () => number;
}): StreamAttemptHooks<ChatCompletionChunk> & {
  firstTokenAt: () => number | undefined;
  /** The error ended an attempt that is already recorded */
  recorded: (error: unknown) => boolean;
} {
  let firstTokenAt: number | undefined;
  const recordedErrors = new WeakSet<object>();

  return {
    firstTokenAt: () => firstTokenAt,
    recorded: (error) =>
      typeof error === "object" && error !== null && recordedErrors.has(error),
    onChunk: (chunk) => {
      if (firstTokenAt === undefined && hasGeneratedToken(chunk)) {
        firstTokenAt = Date.now();
      }
    },
    onDiscardedAttempt: (chunks, error) => {
      const ttftMs =
        firstTokenAt === undefined
          ? undefined
          : firstTokenAt - options.requestStartTime;
      firstTokenAt = undefined;
      if (typeof error === "object" && error !== null) {
        recordedErrors.add(error);
      }
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
        call: {
          ...summarizeAttempt(chunks),
          ttftMs,
          discarded: true,
          aborted: options.abortSignal.aborted || undefined,
          ...describeError(error),
        },
      });
    },
  };
}
