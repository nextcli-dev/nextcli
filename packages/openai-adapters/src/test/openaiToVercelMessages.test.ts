import { describe, expect, it } from "vitest";

import { convertOpenAIMessagesToVercel } from "../openaiToVercelMessages.js";

describe("convertOpenAIMessagesToVercel", () => {
  it("joins system and developer messages into the instructions", () => {
    const result = convertOpenAIMessagesToVercel([
      { role: "system", content: "Be brief." },
      { role: "developer", content: [{ type: "text", text: "Use tools." }] },
      { role: "user", content: "hi" },
    ]);

    expect(result.instructions).toBe("Be brief.\n\nUse tools.");
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("converts web and data image URLs", () => {
    const { messages } = convertOpenAIMessagesToVercel([
      {
        role: "user",
        content: [
          { type: "text", text: "Compare" },
          { type: "image_url", image_url: { url: "https://x.test/a.png" } },
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,AAAA" },
          },
        ],
      },
    ]);

    expect(messages[0].content).toEqual([
      { type: "text", text: "Compare" },
      { type: "image", image: new URL("https://x.test/a.png") },
      { type: "image", image: "AAAA", mediaType: "image/jpeg" },
    ]);
  });

  it("sends Claude's signed and redacted thinking back, and drops nothing", () => {
    const { messages } = convertOpenAIMessagesToVercel([
      {
        role: "assistant",
        content: "Answer",
        reasoning_details: [
          { type: "reasoning.text", text: "Think", signature: "sig", index: 0 },
          { type: "reasoning.encrypted", data: "opaque", index: 1 },
        ],
      } as any,
    ]);

    expect(messages[0].content).toEqual([
      {
        type: "reasoning",
        text: "Think",
        providerOptions: { anthropic: { signature: "sig" } },
      },
      {
        type: "reasoning",
        text: "",
        providerOptions: { anthropic: { redactedData: "opaque" } },
      },
      { type: "text", text: "Answer" },
    ]);
  });

  it("groups OpenAI's summary and encrypted reasoning by item", () => {
    const { messages } = convertOpenAIMessagesToVercel([
      {
        role: "assistant",
        content: "Answer",
        reasoning_details: [
          { type: "reasoning.summary", summary: "Sum", id: "rs_1", index: 0 },
          { type: "reasoning.encrypted", data: "enc", id: "rs_1", index: 0 },
        ],
      } as any,
    ]);

    expect(messages[0].content).toEqual([
      {
        type: "reasoning",
        text: "Sum",
        providerOptions: {
          openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" },
        },
      },
      { type: "text", text: "Answer" },
    ]);
  });

  it("sends plain reasoning_content back as reasoning (DeepSeek, Kimi, gateways)", () => {
    const { messages } = convertOpenAIMessagesToVercel([
      {
        role: "assistant",
        content: null,
        reasoning_content: "Let me look.",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read", arguments: '{"path":"a"}' },
          },
        ],
      } as any,
      { role: "tool", tool_call_id: "c1", content: "file body" },
    ]);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Let me look." },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "read",
            input: { path: "a" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "read",
            output: { type: "text", value: "file body" },
          },
        ],
      },
    ]);
  });

  it("keeps assistant text given as parts, and an empty reply as a string", () => {
    const { messages } = convertOpenAIMessagesToVercel([
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: null },
    ]);

    expect(messages).toEqual([
      { role: "assistant", content: "Hi" },
      { role: "assistant", content: "" },
    ]);
  });
});
