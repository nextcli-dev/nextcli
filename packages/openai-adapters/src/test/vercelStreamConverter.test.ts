import { describe, expect, test } from "vitest";

import {
  convertVercelStream,
  toOpenAIUsage,
  VercelStreamConverter,
  type VercelStreamPart,
} from "../vercelStreamConverter.js";

async function collect(parts: VercelStreamPart[]) {
  async function* source() {
    yield* parts;
  }
  const chunks = [];
  for await (const chunk of convertVercelStream(source(), { model: "m" })) {
    chunks.push(chunk);
  }
  return chunks;
}

const deltas = (chunks: Awaited<ReturnType<typeof collect>>) =>
  chunks.filter((c) => c.choices.length > 0).map((c) => c.choices[0].delta);

describe("VercelStreamConverter", () => {
  test("streams text with no finish reason until the end", async () => {
    const chunks = await collect([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", text: "Hel" },
      { type: "text-delta", id: "t", text: "lo" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop" },
    ]);

    expect(chunks.map((c) => c.choices[0]?.delta.content)).toEqual([
      "Hel",
      "lo",
      undefined,
    ]);
    expect(chunks.map((c) => c.choices[0]?.finish_reason)).toEqual([
      null,
      null,
      "stop",
    ]);
  });

  test.each([
    ["length", "length"],
    ["tool-calls", "tool_calls"],
    ["content-filter", "content_filter"],
    ["other", "stop"],
    ["interrupted", "length"],
  ])("maps the %s finish reason to %s", async (from, to) => {
    const chunks = await collect([{ type: "finish", finishReason: from }]);
    expect(chunks[0].choices[0].finish_reason).toBe(to);
  });

  test("throws for an error finish instead of reporting a stop", async () => {
    await expect(
      collect([
        { type: "text-delta", id: "t", text: "Part" },
        { type: "finish", finishReason: "error" },
      ]),
    ).rejects.toThrow("ended the response with an error");
  });

  test("throws an AbortError for an aborted stream", async () => {
    // AI SDK 7 ends an aborted stream with an abort part and no finish
    const result = collect([
      { type: "text-delta", id: "t", text: "Part" },
      { type: "abort", reason: "cancelled by user" },
    ]);
    await expect(result).rejects.toMatchObject({
      name: "AbortError",
      message: "cancelled by user",
    });
  });

  test("passes a gateway's reasoning_details through from the raw chunks", async () => {
    const details = [
      { type: "reasoning.text", text: "Hm", signature: "sig", index: 0 },
    ];
    const parts: VercelStreamPart[] = [
      {
        type: "raw",
        rawValue: {
          choices: [{ delta: { reasoning: "Hm", reasoning_details: details } }],
        },
      },
      { type: "reasoning-delta", id: "reasoning-0", text: "Hm" },
      { type: "raw", rawValue: { choices: [{ delta: { content: "Hi" } }] } },
      { type: "text-delta", id: "txt-0", text: "Hi" },
    ];
    const converter = new VercelStreamConverter({
      model: "m",
      reasoningDetailsFromRaw: true,
    });

    expect(
      parts
        .flatMap((part) => converter.convert(part))
        .map((c) => c.choices[0].delta),
    ).toEqual([
      { role: "assistant", reasoning_details: details },
      { role: "assistant", reasoning_content: "Hm" },
      { role: "assistant", content: "Hi" },
    ]);
  });

  test("streams reasoning text with a reasoning detail per block", async () => {
    const chunks = await collect([
      { type: "reasoning-start", id: "0" },
      { type: "reasoning-delta", id: "0", text: "Think" },
      { type: "reasoning-delta", id: "3", text: "Again" },
    ]);

    expect(deltas(chunks)).toEqual([
      {
        role: "assistant",
        reasoning_content: "Think",
        reasoning_details: [
          { type: "reasoning.text", text: "Think", index: 0 },
        ],
      },
      {
        role: "assistant",
        reasoning_content: "Again",
        reasoning_details: [
          { type: "reasoning.text", text: "Again", index: 1 },
        ],
      },
    ]);
  });

  test("keeps Claude's signature and redacted thinking for the next request", async () => {
    const chunks = await collect([
      { type: "reasoning-start", id: "0" },
      { type: "reasoning-delta", id: "0", text: "Hmm" },
      {
        type: "reasoning-delta",
        id: "0",
        text: "",
        providerMetadata: { anthropic: { signature: "sig" } },
      },
      {
        type: "reasoning-start",
        id: "1",
        providerMetadata: { anthropic: { redactedData: "opaque" } },
      },
    ]);

    expect(deltas(chunks).map((d: any) => d.reasoning_details)).toEqual([
      [{ type: "reasoning.text", text: "Hmm", index: 0 }],
      [{ type: "reasoning.text", signature: "sig", index: 0 }],
      [{ type: "reasoning.encrypted", data: "opaque", index: 1 }],
    ]);
  });

  test("keeps OpenAI's reasoning summary and encrypted content per item", async () => {
    const chunks = await collect([
      {
        type: "reasoning-delta",
        id: "rs_1:0",
        text: "Summary",
        providerMetadata: { openai: { itemId: "rs_1" } },
      },
      {
        type: "reasoning-end",
        id: "rs_1:0",
        providerMetadata: {
          openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" },
        },
      },
    ]);

    expect(deltas(chunks).map((d: any) => d.reasoning_details)).toEqual([
      [{ type: "reasoning.summary", summary: "Summary", id: "rs_1", index: 0 }],
      [{ type: "reasoning.encrypted", id: "rs_1", data: "enc", index: 0 }],
    ]);
  });

  test("gives parallel tool calls their own index", async () => {
    const chunks = await collect([
      { type: "tool-input-start", id: "a", toolName: "read" },
      { type: "tool-input-start", id: "b", toolName: "grep" },
      { type: "tool-input-delta", id: "a", delta: '{"p":1}' },
      { type: "tool-input-delta", id: "b", delta: '{"q":2}' },
      { type: "tool-call", toolCallId: "a", toolName: "read", input: { p: 1 } },
      { type: "finish", finishReason: "tool-calls" },
    ]);

    expect(deltas(chunks).flatMap((d) => d.tool_calls ?? [])).toEqual([
      {
        index: 0,
        id: "a",
        type: "function",
        function: { name: "read", arguments: "" },
      },
      {
        index: 1,
        id: "b",
        type: "function",
        function: { name: "grep", arguments: "" },
      },
      { index: 0, function: { arguments: '{"p":1}' } },
      { index: 1, function: { arguments: '{"q":2}' } },
    ]);
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe("tool_calls");
  });

  test("sends a tool call that arrives whole, with Gemini's thought signature", async () => {
    const chunks = await collect([
      {
        type: "tool-call",
        toolCallId: "c",
        toolName: "read",
        input: { path: "x" },
        providerMetadata: { google: { thoughtSignature: "ts" } },
      },
    ]);

    expect(deltas(chunks)[0].tool_calls).toEqual([
      {
        index: 0,
        id: "c",
        type: "function",
        function: { name: "read", arguments: '{"path":"x"}' },
        extra_content: { google: { thought_signature: "ts" } },
      },
    ]);
  });

  test("adds only the thought signature to a call already streamed", async () => {
    const chunks = await collect([
      { type: "tool-input-start", id: "c", toolName: "read" },
      {
        type: "tool-call",
        toolCallId: "c",
        toolName: "read",
        input: {},
        providerMetadata: { google: { thoughtSignature: "ts" } },
      },
    ]);

    expect(deltas(chunks)[1].tool_calls).toEqual([
      { index: 0, extra_content: { google: { thought_signature: "ts" } } },
    ]);
  });

  test("ends with a usage chunk", async () => {
    const chunks = await collect([
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    ]);

    expect(chunks.at(-1)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  test("throws an HTTP error with its status, URL and body", () => {
    const converter = new VercelStreamConverter({ model: "m" });
    const error = Object.assign(new Error("Not Found"), {
      name: "AI_APICallError",
      url: "https://api.oneprovider.dev/beta/completions",
      statusCode: 404,
      responseBody:
        '{"error":{"type":"not_found_error","message":"Not found"}}',
    });

    expect(() => converter.convert({ type: "error", error })).toThrow(
      'HTTP 404 from https://api.oneprovider.dev/beta/completions\n\n{"error":{"type":"not_found_error","message":"Not found"}}',
    );
  });

  test("throws other errors as they are", () => {
    const converter = new VercelStreamConverter({ model: "m" });
    const error = new DOMException("Aborted", "AbortError");
    expect(() => converter.convert({ type: "error", error })).toThrow(error);
  });

  test.each<VercelStreamPart>([
    { type: "start" },
    { type: "start-step" },
    { type: "finish-step", finishReason: "stop" },
    { type: "text-start", id: "t" },
    { type: "reasoning-end", id: "0" },
    { type: "tool-input-end", id: "a" },
    { type: "tool-result", toolCallId: "a" },
    { type: "source", source: {} },
    { type: "file", file: {} },
    {
      type: "raw",
      rawValue: { choices: [{ delta: { reasoning_details: [{}] } }] },
    },
  ])("emits nothing for $type", (part) => {
    expect(new VercelStreamConverter({ model: "m" }).convert(part)).toEqual([]);
  });
});

describe("toOpenAIUsage", () => {
  test("counts cached tokens inside prompt_tokens and lists them apart", () => {
    expect(
      toOpenAIUsage({
        inputTokens: 1000,
        outputTokens: 50,
        inputTokenDetails: {
          noCacheTokens: 100,
          cacheReadTokens: 800,
          cacheWriteTokens: 100,
        },
        outputTokenDetails: { reasoningTokens: 30 },
      }),
    ).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: {
        cached_tokens: 800,
        cache_read_tokens: 800,
        cache_write_tokens: 100,
      },
      completion_tokens_details: { reasoning_tokens: 30 },
    });
  });

  test("leaves out details the provider didn't report", () => {
    expect(toOpenAIUsage({ inputTokens: 3, outputTokens: 4 })).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
    });
  });
});
