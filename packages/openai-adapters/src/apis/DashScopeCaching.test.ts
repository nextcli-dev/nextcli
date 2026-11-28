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
async function sent(
  config: Record<string, unknown>,
  messages = toolLoop(),
  model = "qwen3.8-max",
) {
  const api = constructLlmApi({
    provider: "openai",
    apiKey: "sk-test",
    ...config,
  } as never) as any;
  const create = vi
    .spyOn(api.openai.chat.completions, "create")
    .mockResolvedValue((async function* () {})() as never);
  for await (const _ of api.chatCompletionStream(
    { model, messages, stream: true },
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
    // No assistant reply yet, so no earlier request's end to mark
    expect(body.messages[0]).toMatchObject({ content: "First" });
    expect((body.messages[1]!.content as any[])[0]).toMatchObject({
      cache_control: ephemeral,
    });
    expect((body.messages[1]!.content as any[])[1]).not.toHaveProperty(
      "cache_control",
    );
    expect(body.messages[2]).toMatchObject({ content: "" });
  });

  it("marks only models the catalog prices with cache writes on that host", async () => {
    const intl = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
    const china = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const plan = "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1";
    const marked = async (apiBase: string, model: string) =>
      markers(await sent({ apiBase }, toolLoop(), model)).some(Boolean);

    expect(await marked(intl, "qwen4-max-preview")).toBe(true);
    expect(await marked(plan, "qwen4-max-preview")).toBe(true);
    // No cache-write price for it in China's catalog
    expect(await marked(china, "qwen4-max-preview")).toBe(false);
    // No cache prices, or implicit cache reads only
    expect(await marked(intl, "qwen-max")).toBe(false);
    expect(await marked(intl, "kimi-k3")).toBe(false);
    // Another maker's model on Alibaba's endpoint
    expect(await marked(china, "deepseek-v4-pro")).toBe(false);
  });

  it("marks where the previous request ended, however many tool results a round adds", async () => {
    const round = (prefix: string) => {
      const ids = Array.from({ length: 25 }, (_, index) => `${prefix}${index}`);
      return [
        {
          role: "assistant" as const,
          content: "",
          tool_calls: ids.map((id) => ({
            id,
            type: "function" as const,
            function: { name: "Read", arguments: "{}" },
          })),
        },
        ...ids.map((id) => ({
          role: "tool" as const,
          tool_call_id: id,
          content: `output ${id}`,
        })),
      ];
    };
    const body = await sent(
      { apiBase: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
      [
        { role: "system", content: "You are a helper." },
        { role: "user", content: "Read everything" },
        ...round("a"),
        ...round("b"),
      ],
    );
    const at = markers(body)
      .map((isMarked, index) => (isMarked ? index : -1))
      .filter((index) => index >= 0);
    // The system message, the first round's last result, the newest result
    expect(at).toEqual([0, 27, 53]);
  });

  it("marks requests that don't stream", async () => {
    const api = constructLlmApi({
      provider: "openai",
      apiKey: "sk-test",
      apiBase: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    }) as any;
    const create = vi
      .spyOn(api.openai.chat.completions, "create")
      .mockResolvedValue({ choices: [] } as never);
    await api.chatCompletionNonStream(
      { model: "qwen3.8-max", messages: toolLoop(), stream: false },
      new AbortController().signal,
    );
    expect(markers(create.mock.calls[0]![0] as any)).toEqual([
      true,
      false,
      false,
      true,
      false,
      true,
    ]);
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
