/**
 * Converts AI SDK stream parts to OpenAI ChatCompletionChunks, in the same
 * shape the native adapters stream:
 *
 * - reasoning text in `reasoning_content`, plus `reasoning_details` items
 *   keyed by block, carrying Claude's signatures and redacted thinking and
 *   OpenAI's encrypted reasoning, so they can be sent back
 *   (openaiToVercelMessages.ts turns them into reasoning parts again)
 * - one tool-call index per call, so parallel calls stay apart
 * - `finish_reason` null until a last chunk with the real reason; an
 *   aborted stream throws an AbortError and a failed one throws its error
 * - usage where `prompt_tokens` counts every input token, cached ones
 *   included, and the cache reads and writes are given as parts of it
 */

import type {
  ChatCompletionChunk,
  CompletionUsage,
} from "openai/resources/index";
import { formatAiSdkError } from "./aiSdkErrors.js";
import { usageChatChunk } from "./util.js";

type ProviderMetadata = Record<string, Record<string, unknown> | undefined>;

interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokenDetails?: {
    textTokens?: number;
    reasoningTokens?: number;
  };
}

export type VercelStreamPart =
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; text: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string; providerMetadata?: ProviderMetadata }
  | {
      type: "reasoning-delta";
      id: string;
      text: string;
      providerMetadata?: ProviderMetadata;
    }
  | { type: "reasoning-end"; id: string; providerMetadata?: ProviderMetadata }
  | ({ type: "source"; source?: any } & Record<string, any>)
  | { type: "file"; file: any }
  | { type: "reasoning-file"; file: any }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
      providerMetadata?: ProviderMetadata;
    }
  | { type: "tool-input-start"; id: string; toolName: string }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-input-end"; id: string }
  | { type: "tool-result"; toolCallId: string; result?: unknown }
  | { type: "start-step" }
  | {
      type: "finish-step";
      response?: unknown;
      finishReason?: string;
      usage?: Usage;
    }
  | { type: "start" }
  | { type: "finish"; finishReason: string; totalUsage?: Usage }
  | { type: "abort"; reason?: string }
  | { type: "error"; error: unknown }
  | { type: "raw"; rawValue: unknown };

export interface VercelStreamConverterOptions {
  model: string;
  /**
   * Take `reasoning_details` as the provider streamed them, from the raw
   * chunks (streamText's includeRawChunks), instead of building them from
   * the reasoning parts. For gateways such as OpenRouter, whose details
   * carry each upstream vendor's signatures and encrypted reasoning.
   */
  reasoningDetailsFromRaw?: boolean;
}

type Delta = ChatCompletionChunk.Choice["delta"] & {
  reasoning_content?: string;
  reasoning_details?: Record<string, unknown>[];
};

const FINISH_REASONS: Record<
  string,
  ChatCompletionChunk.Choice["finish_reason"]
> = {
  stop: "stop",
  length: "length",
  "content-filter": "content_filter",
  "tool-calls": "tool_calls",
  // The provider's stream ended before it said it was done, so the reply
  // may be cut off: report it as cut off, so the caller can continue it
  interrupted: "length",
};

/** OpenAI usage from AI SDK usage; see the file comment for the convention */
export function toOpenAIUsage(usage: Usage): CompletionUsage {
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.totalTokens ?? promptTokens + completionTokens,
    ...((cacheRead !== undefined || cacheWrite !== undefined) && {
      prompt_tokens_details: {
        cached_tokens: cacheRead ?? 0,
        cache_read_tokens: cacheRead ?? 0,
        cache_write_tokens: cacheWrite ?? 0,
      } as CompletionUsage["prompt_tokens_details"],
    }),
    ...(reasoningTokens !== undefined && {
      completion_tokens_details: { reasoning_tokens: reasoningTokens },
    }),
  };
}

/**
 * Converts one stream's parts. Stateful: reasoning blocks and tool calls get
 * their indexes in the order they appear, so create one per stream.
 */
export class VercelStreamConverter {
  private readonly model: string;
  private readonly reasoningDetailsFromRaw: boolean;
  private readonly reasoningIndexes = new Map<string, number>();
  private readonly toolIndexes = new Map<string, number>();

  constructor(options: VercelStreamConverterOptions) {
    this.model = options.model;
    this.reasoningDetailsFromRaw = options.reasoningDetailsFromRaw ?? false;
  }

  convert(part: VercelStreamPart): ChatCompletionChunk[] {
    switch (part.type) {
      case "text-delta":
        return part.text ? [this.chunk({ content: part.text })] : [];

      case "reasoning-start": {
        // Claude's redacted thinking arrives whole, on the block's start
        const redacted = part.providerMetadata?.anthropic?.redactedData;
        if (typeof redacted !== "string") return [];
        return [
          this.reasoningChunk({
            type: "reasoning.encrypted",
            data: redacted,
            index: this.reasoningIndex(part.id),
          }),
        ];
      }

      case "reasoning-delta":
        if (this.reasoningDetailsFromRaw) {
          return part.text
            ? [this.chunk({ reasoning_content: part.text })]
            : [];
        }
        return this.reasoningDelta(part);

      case "raw":
        return this.rawReasoningDetails(part.rawValue);

      case "reasoning-end": {
        // OpenAI's encrypted reasoning arrives with the finished item
        const openai = part.providerMetadata?.openai;
        const encrypted = openai?.reasoningEncryptedContent;
        if (typeof encrypted !== "string") return [];
        const itemId = String(openai?.itemId ?? part.id);
        return [
          this.reasoningChunk({
            type: "reasoning.encrypted",
            id: itemId,
            data: encrypted,
            index: this.reasoningIndex(itemId),
          }),
        ];
      }

      case "tool-input-start":
        return [
          this.toolChunk({
            index: this.toolIndex(part.id),
            id: part.id,
            type: "function",
            function: { name: part.toolName, arguments: "" },
          }),
        ];

      case "tool-input-delta":
        return [
          this.toolChunk({
            index: this.toolIndex(part.id),
            function: { arguments: part.delta },
          }),
        ];

      case "tool-call": {
        const thoughtSignature =
          part.providerMetadata?.google?.thoughtSignature ??
          part.providerMetadata?.vertex?.thoughtSignature;
        const extra =
          typeof thoughtSignature === "string"
            ? {
                extra_content: {
                  google: { thought_signature: thoughtSignature },
                },
              }
            : {};
        if (!this.toolIndexes.has(part.toolCallId)) {
          // A provider that sends the call whole, without input deltas
          return [
            this.toolChunk({
              index: this.toolIndex(part.toolCallId),
              id: part.toolCallId,
              type: "function",
              function: {
                name: part.toolName,
                arguments:
                  typeof part.input === "string"
                    ? part.input
                    : JSON.stringify(part.input ?? {}),
              },
              ...extra,
            }),
          ];
        }
        if (!extra.extra_content) return [];
        // The arguments were streamed already; only the signature is new
        return [
          this.toolChunk({
            index: this.toolIndex(part.toolCallId),
            ...extra,
          }),
        ];
      }

      case "finish": {
        if (part.finishReason === "error") {
          // An error part normally comes first and throws; never let a failed
          // call look finished
          throw formatAiSdkError(
            new Error("The provider ended the response with an error."),
          );
        }
        const chunks = [
          this.chunk({}, FINISH_REASONS[part.finishReason] ?? "stop"),
        ];
        if (part.totalUsage) {
          chunks.push(
            usageChatChunk({
              model: this.model,
              usage: toOpenAIUsage(part.totalUsage),
            }),
          );
        }
        return chunks;
      }

      case "error":
        throw formatAiSdkError(part.error);

      case "abort":
        // AI SDK ends an aborted stream quietly, with no finish part. Throw
        // as the native adapters do, so a cancelled call never reads as a
        // finished answer with whatever had streamed so far.
        throw new DOMException(
          part.reason ?? "This operation was aborted",
          "AbortError",
        );

      case "text-start":
      case "text-end":
      case "source":
      case "file":
      case "reasoning-file":
      case "tool-input-end":
      case "tool-result":
      case "start-step":
      case "finish-step":
      case "start":
        return [];

      default:
        return [];
    }
  }

  private reasoningDelta(
    part: Extract<VercelStreamPart, { type: "reasoning-delta" }>,
  ): ChatCompletionChunk[] {
    const anthropicSignature = part.providerMetadata?.anthropic?.signature;
    const openaiItemId = part.providerMetadata?.openai?.itemId;
    const chunks: ChatCompletionChunk[] = [];
    if (part.text) {
      // OpenAI streams reasoning summaries; everyone else, reasoning text
      const detail =
        typeof openaiItemId === "string"
          ? {
              type: "reasoning.summary",
              summary: part.text,
              id: openaiItemId,
              index: this.reasoningIndex(openaiItemId),
            }
          : {
              type: "reasoning.text",
              text: part.text,
              index: this.reasoningIndex(part.id),
            };
      chunks.push(
        this.chunk({
          reasoning_content: part.text,
          reasoning_details: [detail],
        }),
      );
    }
    if (typeof anthropicSignature === "string" && anthropicSignature) {
      chunks.push(
        this.reasoningChunk({
          type: "reasoning.text",
          signature: anthropicSignature,
          index: this.reasoningIndex(part.id),
        }),
      );
    }
    return chunks;
  }

  private rawReasoningDetails(rawValue: unknown): ChatCompletionChunk[] {
    if (!this.reasoningDetailsFromRaw) return [];
    const details = (rawValue as any)?.choices?.[0]?.delta?.reasoning_details;
    if (!Array.isArray(details) || details.length === 0) return [];
    return [this.chunk({ reasoning_details: details })];
  }

  private reasoningIndex(key: string): number {
    let index = this.reasoningIndexes.get(key);
    if (index === undefined) {
      index = this.reasoningIndexes.size;
      this.reasoningIndexes.set(key, index);
    }
    return index;
  }

  private toolIndex(toolCallId: string): number {
    let index = this.toolIndexes.get(toolCallId);
    if (index === undefined) {
      index = this.toolIndexes.size;
      this.toolIndexes.set(toolCallId, index);
    }
    return index;
  }

  private reasoningChunk(detail: Record<string, unknown>): ChatCompletionChunk {
    return this.chunk({ reasoning_details: [detail] });
  }

  private toolChunk(toolCall: Record<string, unknown>): ChatCompletionChunk {
    return this.chunk({
      tool_calls: [
        toolCall as unknown as ChatCompletionChunk.Choice.Delta.ToolCall,
      ],
    });
  }

  private chunk(
    delta: Delta,
    finishReason: ChatCompletionChunk.Choice["finish_reason"] = null,
  ): ChatCompletionChunk {
    return {
      id: "",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: this.model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", ...delta },
          finish_reason: finishReason,
          logprobs: null,
        },
      ],
    };
  }
}

/** Converts an AI SDK stream to OpenAI ChatCompletionChunks */
export async function* convertVercelStream(
  stream: AsyncIterable<VercelStreamPart>,
  options: VercelStreamConverterOptions,
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  const converter = new VercelStreamConverter(options);
  for await (const part of stream) {
    yield* converter.convert(part);
  }
}
