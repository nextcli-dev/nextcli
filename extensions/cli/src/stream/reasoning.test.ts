import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import { describe, expect, it, vi } from "vitest";

import {
  mergeReasoningDetailDeltas,
  ReasoningAccumulator,
} from "./reasoning.js";
import { processStreamingResponse } from "./streamChatResponse.js";

describe("ReasoningAccumulator", () => {
  it("collects reasoning_content and remembers the field", () => {
    const acc = new ReasoningAccumulator();
    acc.add({ reasoning_content: "First, " });
    acc.add({ reasoning_content: "check the file." });
    expect(acc.result()).toMatchObject({
      text: "First, check the file.",
      textField: "reasoning_content",
      active: false,
    });
  });

  it("collects a string reasoning field (OpenRouter)", () => {
    const acc = new ReasoningAccumulator();
    acc.add({ reasoning: "Thinking" });
    expect(acc.result()).toMatchObject({
      text: "Thinking",
      textField: "reasoning",
    });
  });

  it("ignores a non-string reasoning field", () => {
    const acc = new ReasoningAccumulator();
    acc.add({
      reasoning: { content: [{ type: "reasoning_text", text: "x" }] },
    });
    expect(acc.result()).toBeUndefined();
  });

  it("returns undefined when there was no reasoning", () => {
    const acc = new ReasoningAccumulator();
    acc.add({ content: "Hello" });
    acc.add({ reasoning_content: "" });
    expect(acc.result()).toBeUndefined();
  });

  it("merges reasoning_details deltas", () => {
    const acc = new ReasoningAccumulator();
    acc.add({
      reasoning_details: [{ type: "reasoning.text", text: "a", index: 0 }],
    });
    acc.add({
      reasoning_details: [{ type: "reasoning.text", text: "b", index: 0 }],
    });
    acc.add({
      reasoning_details: [
        { type: "reasoning.text", signature: "sig", index: 0 },
      ],
    });
    expect(acc.result()?.details).toEqual([
      { type: "reasoning.text", text: "ab", signature: "sig", index: 0 },
    ]);
  });
});

describe("mergeReasoningDetailDeltas", () => {
  it("keeps blocks with different indexes separate", () => {
    const merged = mergeReasoningDetailDeltas(
      [{ type: "reasoning.text", text: "one", signature: "s1", index: 0 }],
      [{ type: "reasoning.text", text: "two", signature: "s2", index: 1 }],
    );
    expect(merged).toEqual([
      { type: "reasoning.text", text: "one", signature: "s1", index: 0 },
      { type: "reasoning.text", text: "two", signature: "s2", index: 1 },
    ]);
  });

  it("merges items without an index by type", () => {
    const merged = mergeReasoningDetailDeltas(
      [{ type: "reasoning.summary", summary: "a" }],
      [
        { type: "reasoning.summary", summary: "b" },
        { type: "reasoning.encrypted", data: "enc" },
      ],
    );
    expect(merged).toEqual([
      { type: "reasoning.summary", summary: "ab" },
      { type: "reasoning.encrypted", data: "enc" },
    ]);
  });
});

describe("processStreamingResponse reasoning", () => {
  function chunk(delta: Record<string, unknown>) {
    return {
      id: "test",
      object: "chat.completion.chunk",
      created: 0,
      model: "test-model",
      choices: [{ index: 0, delta, finish_reason: null }],
    };
  }

  async function run(chunks: unknown[]) {
    const llmApi = {
      chatCompletionStream: vi.fn().mockImplementation(async function* () {
        yield* chunks;
      }),
    } as unknown as BaseLlmApi;
    return processStreamingResponse({
      chatHistory: [
        { message: { role: "user", content: "Hi" }, contextItems: [] },
      ],
      model: {
        model: "test-model",
        provider: "test",
      } as unknown as ModelConfig,
      llmApi,
      abortController: { signal: { aborted: false } } as AbortController,
      systemMessage: "System",
      isHeadless: true,
    });
  }

  it("returns the reasoning streamed before and with the content", async () => {
    const result = await run([
      chunk({ reasoning_content: "Let me think. " }),
      chunk({ reasoning_content: "Done.", content: "Answer" }),
    ]);
    expect(result.content).toBe("Answer");
    expect(result.reasoning).toMatchObject({
      text: "Let me think. Done.",
      textField: "reasoning_content",
    });
  });

  it("returns no reasoning when none was streamed", async () => {
    const result = await run([chunk({ content: "Answer" })]);
    expect(result.reasoning).toBeUndefined();
  });
});
