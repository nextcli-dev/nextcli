import type { ChatCompletionCreateParams } from "openai/resources/index";
import { describe, expect, it, vi } from "vitest";

import { constructLlmApi } from "../index.js";

const ephemeral = { type: "ephemeral" };

// A tool loop: the last message is a tool result
function toolLoop(): ChatCompletionCreateParams["messages"] {
  return [
    { role: "system", content: "You are a helper." },
    { role: "user", content: "Read a.ts" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "Read", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "file a" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "c2",
          type: "function",
          function: { name: "Read", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "c2", content: "file b" },
  ];
}

/** The body the OpenAI SDK gets for one streamed request */
async function sent(config: Record<string, unknown>, messages = toolLoop()) {
  const api = constructLlmApi({
    provider: "openai",
    apiKey: "sk-test",
    ...config,
  } as never) as any;
  const create = vi
    .spyOn(api.openai.chat.completions, "create")
    .mockResolvedValue((async function* () {})() as never);
  for await (const _ of api.chatCompletionStream(
    { model: "qwen4-max-preview", messages, stream: true },
    new AbortController().signal,
  ));
  return create.mock.calls[0]![0] as ChatCompletionCreateParams;
}

const markers = (body: ChatCompletionCreateParams) =>
  body.messages.map((message) =>
    Array.isArray(message.content)
      ? message.content.some((part: any) => part.cache_control)
      : false,
  );

describe("DashScope prompt cache markers", () => {
  it("marks the system message and the last two user or tool messages on Qwen hosts", async () => {
    for (const apiBase of [
      "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1",
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    ]) {
      const body = await sent({ apiBase });
      expect(markers(body)).toEqual([true, false, false, true, false, true]);
      expect(body.messages[5]).toMatchObject({
        role: "tool",
        content: [{ type: "text", text: "file b", cache_control: ephemeral }],
      });
    }
  });

  it("leaves the caller's messages as they were", async () => {
    const messages = toolLoop();
    const before = structuredClone(messages);
    await sent(
      { apiBase: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
      messages,
    );
    expect(messages).toEqual(before);
  });

  it("marks the last text part, skipping messages without text", async () => {
    const body = await sent(
      { apiBase: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
      [
        { role: "user", content: "First" },
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,x" },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "" },
      ],
    );
    expect(body.messages[0]).toMatchObject({
      content: [{ text: "First", cache_control: ephemeral }],
    });
    expect((body.messages[1]!.content as any[])[0]).toMatchObject({
      cache_control: ephemeral,
    });
    expect((body.messages[1]!.content as any[])[1]).not.toHaveProperty(
      "cache_control",
    );
    expect(body.messages[2]).toMatchObject({ content: "" });
  });

  it("adds no markers elsewhere, or with prompt caching off", async () => {
    for (const config of [
      { apiBase: "https://api.openai.com/v1/" },
      { apiBase: "https://api.deepseek.com/v1" },
      {
        apiBase: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        cachingStrategy: "none",
      },
    ]) {
      const body = await sent(config);
      expect(markers(body).some(Boolean)).toBe(false);
    }
  });
});
