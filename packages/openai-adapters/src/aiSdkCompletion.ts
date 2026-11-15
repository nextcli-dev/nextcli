/**
 * A non-streamed chat completion, collected from the converted stream, so a
 * non-streamed AI SDK call returns what a streamed one does: reasoning and
 * its details, every tool call, the finish reason and the full usage.
 */

import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessageToolCall,
  CompletionUsage,
} from "openai/resources/index";

type ReasoningDetail = Record<string, unknown> & {
  type?: string;
  index?: number;
};

const CONCATENATED = new Set(["text", "summary", "signature"]);

/** Merges a detail delta into the item with the same type and index */
function mergeDetail(details: ReasoningDetail[], delta: ReasoningDetail) {
  const existing = details.find(
    (detail) => detail.type === delta.type && detail.index === delta.index,
  );
  if (!existing) {
    details.push({ ...delta });
    return;
  }
  for (const [key, value] of Object.entries(delta)) {
    if (value === undefined || value === null) continue;
    existing[key] =
      CONCATENATED.has(key) && typeof value === "string"
        ? String(existing[key] ?? "") + value
        : value;
  }
}

export async function collectChatCompletion(
  chunks: AsyncIterable<ChatCompletionChunk>,
  model: string,
): Promise<ChatCompletion> {
  let content = "";
  let reasoning = "";
  const details: ReasoningDetail[] = [];
  const toolCalls = new Map<number, ChatCompletionMessageToolCall>();
  let finishReason: ChatCompletion.Choice["finish_reason"] = "stop";
  let usage: CompletionUsage | undefined;
  let id = "";

  for await (const chunk of chunks) {
    id ||= chunk.id;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta as ChatCompletionChunk.Choice["delta"] & {
      reasoning_content?: string;
      reasoning_details?: ReasoningDetail[];
    };
    content += delta.content ?? "";
    reasoning += delta.reasoning_content ?? "";
    for (const detail of delta.reasoning_details ?? []) {
      mergeDetail(details, detail);
    }
    for (const call of delta.tool_calls ?? []) {
      const existing = toolCalls.get(call.index);
      if (!existing) {
        toolCalls.set(call.index, {
          id: call.id ?? "",
          type: "function",
          function: {
            name: call.function?.name ?? "",
            arguments: call.function?.arguments ?? "",
          },
          ...((call as any).extra_content && {
            extra_content: (call as any).extra_content,
          }),
        } as ChatCompletionMessageToolCall);
        continue;
      }
      if (existing.type !== "function") continue;
      existing.function.arguments += call.function?.arguments ?? "";
      if ((call as any).extra_content) {
        (existing as any).extra_content = (call as any).extra_content;
      }
    }
  }

  const tool_calls = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call);

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          refusal: null,
          ...(tool_calls.length > 0 && { tool_calls }),
          ...(reasoning && { reasoning_content: reasoning }),
          ...(details.length > 0 && { reasoning_details: details }),
        } as ChatCompletion.Choice["message"],
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
