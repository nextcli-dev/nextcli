import { Readable } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import { ChatMessage, PromptLog } from "../index.js";
import Deepseek from "./llms/Deepseek.js";
import OpenAI from "./llms/OpenAI.js";
import {
  fromChatCompletionChunk,
  fromResponsesChunk,
} from "./openaiTypeConverters.js";
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
  setup?: (llm: Deepseek) => void,
  options: object = {},
): Promise<{ messages: ChatMessage[]; log: PromptLog }> {
  const llm = new Deepseek({ model: "deepseek-v4-pro", apiKey: "k" });
  (llm as any).openaiAdapter = {
    async *chatCompletionStream() {
      for (const c of chunks) {
        yield c;
      }
    },
  };
  setup?.(llm);
  const messages: ChatMessage[] = [];
  const gen = llm.streamChat(
    [{ role: "user", content: "plan it" }],
    new AbortController().signal,
    { log: false, ...options } as any,
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
    expect(end).toEqual({
      finishReason: "length",
      outputTokens: 4096,
      usage: { promptTokens: 10, completionTokens: 4096 },
    });
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
    // The usage chunk isn't a message: no empty step after the thinking
    expect(messages.map((m) => m.role)).toEqual(["thinking", "thinking"]);
    expect(log.usage).toEqual({ promptTokens: 10, completionTokens: 4096 });
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

describe("usage on the OpenAI adapter", () => {
  const detailedUsage = {
    ...usageChunk(300),
    usage: {
      prompt_tokens: 1_000,
      completion_tokens: 300,
      total_tokens: 1_300,
      prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 50 },
      completion_tokens_details: { reasoning_tokens: 120 },
    },
  };
  const expected = {
    promptTokens: 1_000,
    completionTokens: 300,
    promptTokensDetails: { cachedTokens: 800, cacheWriteTokens: 50 },
    completionTokensDetails: { reasoningTokens: 120 },
  };

  test("streamChat returns the usage the provider reported", async () => {
    const { log } = await streamWith([
      chunk({ content: "The plan" }, "stop"),
      detailedUsage,
    ]);
    expect(log.usage).toEqual(expected);
  });

  test("the interaction log gets the same usage", async () => {
    let logged: unknown;
    await streamWith(
      [chunk({ content: "The plan" }, "stop"), detailedUsage],
      (llm) => {
        const logEnd = (llm as any)._logEnd.bind(llm);
        (llm as any)._logEnd = vi.fn((...args: unknown[]) => {
          logged = args[5];
          return logEnd(...args);
        });
      },
    );
    expect(logged).toEqual(expected);
  });

  test("keeps usage that comes with the last text", async () => {
    const { messages, log } = await streamWith([
      { ...chunk({ content: "Done" }, "stop"), usage: detailedUsage.usage },
    ]);
    expect(messages).toEqual([{ role: "assistant", content: "Done" }]);
    expect(log.usage).toEqual(expected);
  });

  test("keeps usage that comes with the last reasoning of a cut-off call", async () => {
    // A thinking message can't carry usage; it is read from the raw chunk
    const { messages, log } = await streamWith([
      chunk({ reasoning_content: "Still thinking" }),
      {
        ...chunk({ reasoning_content: " about it" }, "length"),
        usage: detailedUsage.usage,
      },
    ]);
    expect(messages.map((m) => m.role)).toEqual(["thinking", "thinking"]);
    expect(log.usage).toEqual(expected);
    expect(log.finishReason).toBe("length");
  });

  test("reports no usage when the provider sends none", async () => {
    const { log } = await streamWith([chunk({ content: "Hi" }, "stop")]);
    expect(log.usage).toBeUndefined();
  });

  test("returns the usage of a call that doesn't stream", async () => {
    const { messages, log } = await streamWith(
      [],
      (llm) => {
        (llm as any).openaiAdapter.chatCompletionNonStream = async () => ({
          id: "r1",
          object: "chat.completion",
          created: 0,
          model: "deepseek-v4-pro",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "The plan" },
              finish_reason: "stop",
            },
          ],
          usage: detailedUsage.usage,
        });
      },
      { stream: false },
    );
    expect(messages).toEqual([{ role: "assistant", content: "The plan" }]);
    expect(log.usage).toEqual(expected);
    expect(log.finishReason).toBe("stop");
  });

  test("a native provider's usage message isn't yielded, and its usage is kept", async () => {
    const { messages, log } = await streamWith([], (llm) => {
      // Not on the adapter: the provider's own stream, as Anthropic sends it
      (llm as any).openaiAdapter = undefined;
      (llm as any)._streamChat = async function* () {
        yield { role: "thinking", content: "hmm" };
        yield { role: "assistant", content: "", usage: expected };
      };
    });
    expect(messages).toEqual([{ role: "thinking", content: "hmm" }]);
    expect(log.usage).toEqual(expected);
  });
});

describe("the Responses API", () => {
  const responsesUsage = {
    input_tokens: 2_000,
    output_tokens: 500,
    total_tokens: 2_500,
    input_tokens_details: { cached_tokens: 1_500 },
    output_tokens_details: { reasoning_tokens: 200 },
  };
  const expectedUsage = {
    promptTokens: 2_000,
    completionTokens: 500,
    promptTokensDetails: { cachedTokens: 1_500 },
    completionTokensDetails: { reasoningTokens: 200 },
  };

  /**
   * streamChat on GPT-5, which goes through the provider's own Responses
   * request, against a fake server answering with `body`
   */
  async function respond(
    body: string,
    contentType: string,
    stream: boolean,
  ): Promise<{ messages: ChatMessage[]; log: PromptLog }> {
    const llm = new OpenAI({ model: "gpt-5", apiKey: "k" });
    (llm as any).openaiAdapter = {};
    (llm as any).fetch = vi.fn().mockResolvedValue(
      new Response(Readable.from([Buffer.from(body)]) as any, {
        headers: { "Content-Type": contentType },
      }),
    );
    const gen = llm.streamChat(
      [{ role: "user", content: "hello" }],
      new AbortController().signal,
      { log: false, stream } as any,
    );
    const messages: ChatMessage[] = [];
    let next = await gen.next();
    while (!next.done) {
      messages.push(next.value);
      next = await gen.next();
    }
    return { messages, log: next.value };
  }

  const sse = (events: object[]) =>
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const streamOf = (events: object[]) =>
    respond(sse(events), "text/event-stream", true);
  const text = { type: "response.output_text.delta", delta: "Hi" };

  test("a stream cut off at the output cap ends as length, with its usage", async () => {
    const { messages, log } = await streamOf([
      text,
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: responsesUsage,
        },
      },
    ]);

    // The no-answer notice reads finishReason and outputTokens
    expect(log.finishReason).toBe("length");
    expect(log.streamEndedWithoutFinish).toBe(false);
    expect(log.outputTokens).toBe(500);
    expect(log.usage).toEqual(expectedUsage);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["assistant", "Hi"],
    ]);
  });

  test("a completed stream ends as stop, with its usage", async () => {
    const { log } = await streamOf([
      text,
      {
        type: "response.completed",
        response: { status: "completed", usage: responsesUsage },
      },
    ]);

    expect(log.finishReason).toBe("stop");
    expect(log.usage).toEqual(expectedUsage);
  });

  test("a stream that closes without an end event is flagged", async () => {
    const { log } = await streamOf([text]);

    expect(log.finishReason).toBeUndefined();
    expect(log.streamEndedWithoutFinish).toBe(true);
  });

  test("a whole response with several messages yields each, with how it ended", async () => {
    const { messages, log } = await respond(
      JSON.stringify({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        // Reasoning, then the answer: two messages
        output: [
          { type: "reasoning", id: "r1", summary: [] },
          { type: "message", content: [{ type: "output_text", text: "Hi" }] },
        ],
        usage: responsesUsage,
      }),
      "application/json",
      false,
    );

    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["thinking", ""],
      ["assistant", "Hi"],
    ]);
    expect(log.finishReason).toBe("length");
    expect(log.usage).toEqual(expectedUsage);
  });
});
