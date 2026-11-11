import { describe, expect, test } from "vitest";

import { ChatMessage, PromptLog } from "../index.js";
import Deepseek from "./llms/Deepseek.js";
import { fromChatCompletionChunk } from "./openaiTypeConverters.js";
import { readStreamEnd, StreamEnd } from "./streamEnd.js";

function chunk(delta: object, finishReason: string | null = null) {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-v4-pro",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function usageChunk(completionTokens: number) {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-v4-pro",
    choices: [],
    usage: {
      prompt_tokens: 10,
      completion_tokens: completionTokens,
      total_tokens: 10 + completionTokens,
    },
  };
}

/** Runs streamChat against a fake adapter stream and returns its PromptLog */
async function streamWith(
  chunks: object[],
): Promise<{ messages: ChatMessage[]; log: PromptLog }> {
  const llm = new Deepseek({ model: "deepseek-v4-pro", apiKey: "k" });
  (llm as any).openaiAdapter = {
    async *chatCompletionStream() {
      for (const c of chunks) {
        yield c;
      }
    },
  };
  const messages: ChatMessage[] = [];
  const gen = llm.streamChat(
    [{ role: "user", content: "plan it" }],
    new AbortController().signal,
    { log: false } as any,
  );
  let next = await gen.next();
  while (!next.done) {
    messages.push(next.value);
    next = await gen.next();
  }
  return { messages, log: next.value };
}

describe("readStreamEnd", () => {
  test("keeps the last finish reason and the reported output tokens", () => {
    const end: StreamEnd = {};
    readStreamEnd(end, chunk({ content: "a" }));
    readStreamEnd(end, chunk({}, "length"));
    readStreamEnd(end, usageChunk(4096));
    expect(end).toEqual({ finishReason: "length", outputTokens: 4096 });
  });
});

describe("streamChat on the OpenAI adapter", () => {
  test("reports a thinking-only call cut off by the output cap", async () => {
    const { messages, log } = await streamWith([
      chunk({ reasoning_content: "Let me think about " }),
      chunk({ reasoning_content: "what's best." }),
      chunk({}, "length"),
      usageChunk(4096),
    ]);
    expect(messages.map((m) => m.role)).toEqual(["thinking", "thinking"]);
    expect(log.completion).toBe("");
    expect(log.finishReason).toBe("length");
    expect(log.streamEndedWithoutFinish).toBe(false);
    expect(log.outputTokens).toBe(4096);
  });

  test("flags a stream that closes without a finish reason", async () => {
    const { log } = await streamWith([
      chunk({ reasoning_content: "Let me think" }),
    ]);
    expect(log.finishReason).toBeUndefined();
    expect(log.streamEndedWithoutFinish).toBe(true);
  });

  test("reports a normal answer as stop", async () => {
    const { messages, log } = await streamWith([
      chunk({ reasoning_content: "thinking" }),
      chunk({ content: "The plan" }, "stop"),
    ]);
    expect(messages.at(-1)).toEqual({ role: "assistant", content: "The plan" });
    expect(log.completion).toContain("The plan");
    expect(log.finishReason).toBe("stop");
    expect(log.streamEndedWithoutFinish).toBe(false);
  });
});

describe("fromChatCompletionChunk", () => {
  test("keeps tool calls that arrive in the same delta as text", () => {
    const message = fromChatCompletionChunk(
      chunk({
        content: "Reading it.",
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"filepath":"a"}' },
          },
        ],
      }) as any,
    );
    expect(message).toEqual({
      role: "assistant",
      content: "Reading it.",
      toolCalls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"filepath":"a"}' },
        },
      ],
    });
  });
});

describe("DeepSeek V4 output cap", () => {
  test("is no longer the 4096 fallback, which thinking can use up", () => {
    const llm = new Deepseek({ model: "deepseek-v4-pro", apiKey: "k" });
    expect(llm.contextLength).toBe(1_000_000);
    // min(384K max output, a quarter of the context)
    expect(llm.completionOptions.maxTokens).toBe(250_000);
  });
});
