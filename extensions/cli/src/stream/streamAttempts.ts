import type { ContextSnapshot } from "@nextcli/context";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.mjs";

import type { RequestPrefix } from "../context/snapshot.js";
import type { StreamAttemptHooks } from "../util/exponentialBackoff.js";
import { estimateOutputTokens } from "../util/tokenizer.js";

import { ReasoningAccumulator } from "./reasoning.js";
import {
  describeError,
  hasGeneratedToken,
  recordStreamTelemetry,
  reportsUsage,
} from "./streamChatResponse.helpers.js";
import { readCallEnd } from "./turnContinuation.js";

/**
 * What a discarded attempt produced before it failed, and its output tokens
 * when it reported no usage: the same estimate a finished call gets
 */
function summarizeAttempt(chunks: ChatCompletionChunk[], model: any) {
  const reasoning = new ReasoningAccumulator();
  const toolCalls: string[] = [];
  const calls = new Map<number, { name: string; argumentsStr: string }>();
  let content = "";
  for (const chunk of chunks) {
    const delta: any = chunk.choices?.[0]?.delta ?? {};
    reasoning.add(delta);
    content += delta.content ?? "";
    for (const call of delta.tool_calls ?? []) {
      if (call.function?.name) toolCalls.push(call.function.name);
      const sofar = calls.get(call.index ?? 0) ?? {
        name: "",
        argumentsStr: "",
      };
      sofar.name += call.function?.name ?? "";
      sofar.argumentsStr += call.function?.arguments ?? "";
      calls.set(call.index ?? 0, sofar);
    }
  }
  return {
    call: {
      finishReason: chunks.reduce(readCallEnd, {}).finishReason,
      contentChars: content.length,
      reasoningChars: reasoning.chars(),
      toolCalls,
    },
    outputTokens: estimateOutputTokens(model, {
      content,
      reasoning: reasoning.result(),
      toolCalls: calls.values(),
    }),
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
  /** The same snapshot the kept attempt writes on llm.request */
  context?: ContextSnapshot;
  prefix?: RequestPrefix;
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
      const usage = [...chunks]
        .reverse()
        .find((chunk) => reportsUsage(chunk.usage))?.usage;
      const attempt = summarizeAttempt(chunks, options.model);
      recordStreamTelemetry({
        requestStartTime: options.requestStartTime,
        responseEndTime: Date.now(),
        inputTokens: usage?.prompt_tokens ?? options.estimateInputTokens(),
        outputTokens: usage?.completion_tokens ?? attempt.outputTokens,
        model: options.model,
        tools: options.tools,
        fullUsage: usage,
        context: options.context,
        prefix: options.prefix,
        call: {
          ...attempt.call,
          ttftMs,
          discarded: true,
          aborted: options.abortSignal.aborted || undefined,
          ...describeError(error),
        },
      });
    },
  };
}
