import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ChatMessage, LLMOptions } from "../index.js";

import { BaseLLM } from "./index.js";
import Deepseek from "./llms/Deepseek.js";
import OneProvider from "./llms/OneProvider.js";
import OpenAI from "./llms/OpenAI.js";

/**
 * Core's chat requests on the AI SDK transport against the same requests on
 * the providers' own adapters, through a local server: the request that
 * reaches the network and the messages core yields must be the same. Only
 * the headers each HTTP client sets for itself may differ.
 */

const CLIENT_HEADERS =
  /^(user-agent|accept|accept-encoding|connection|content-length|host|x-stainless-.+)$/;

function sse(events: object[], named = false): string {
  return events
    .map((event) =>
      named
        ? `event: ${(event as any).type}\ndata: ${JSON.stringify(event)}\n\n`
        : `data: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
}

const chunk = (delta: object, finish_reason: string | null = null) => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "m",
  choices: [{ index: 0, delta, finish_reason }],
});

const CHAT_REPLY =
  sse([
    chunk({ role: "assistant", content: "" }),
    chunk({ reasoning_content: "Check a.ts." }),
    chunk({ content: "Reading it." }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_2",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"a.ts"}' },
        },
      ],
    }),
    chunk({}, "tool_calls"),
    {
      ...chunk({}),
      choices: [],
      usage: { prompt_tokens: 50, completion_tokens: 9, total_tokens: 59 },
    },
  ]) + "data: [DONE]\n\n";

const CLAUDE_REPLY = sse(
  [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 40, output_tokens: 1 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Check a.ts." },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig-2" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "Reading it." },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 9 },
    },
    { type: "message_stop" },
  ],
  true,
);

interface Recorded {
  path: string;
  headers: Record<string, string>;
  body: any;
}

let server: Server;
let base: string;
const requests: Recorded[] = [];

// test/vitest.setup.ts swaps in node-fetch's globals; the AI SDK reads web
// streams, as it does in the extension host and the CLI
const nativeGlobals = {
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
};
let setupGlobals: typeof nativeGlobals;

beforeAll(async () => {
  setupGlobals = {
    fetch: globalThis.fetch,
    Request: globalThis.Request,
    Response: globalThis.Response,
  };
  Object.assign(globalThis, nativeGlobals);
  server = createServer((req, res) => {
    let text = "";
    req.on("data", (data) => (text += data));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (!CLIENT_HEADERS.test(key)) headers[key] = String(value);
      }
      if (headers["anthropic-beta"]) {
        headers["anthropic-beta"] = headers["anthropic-beta"]
          .split(",")
          .sort()
          .join(",");
      }
      requests.push({ path: req.url ?? "", headers, body: JSON.parse(text) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(req.url?.endsWith("/messages") ? CLAUDE_REPLY : CHAT_REPLY);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
});

afterAll(async () => {
  Object.assign(globalThis, setupGlobals);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const TOOLS: any[] = [
  {
    type: "function",
    displayTitle: "Read file",
    readonly: true,
    group: "built-in",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "number" } },
        required: ["path"],
      },
    },
  },
];

/** A tool loop as the chat view sends it */
const MESSAGES: ChatMessage[] = [
  { role: "system", content: "You review code." },
  { role: "user", content: "Read a.ts." },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"a.ts"}' },
      },
    ],
  },
  { role: "tool", content: "export const a = 1;", toolCallId: "call_1" },
  { role: "assistant", content: "It exports a." },
  { role: "user", content: "And b.ts?" },
];

/** What core yields, merged: text, thinking, tool calls */
async function chat(llm: BaseLLM, options: object) {
  let content = "";
  let thinking = "";
  const toolCalls: Record<string, { name?: string; args: string }> = {};
  let lastId: string | undefined;
  for await (const message of llm.streamChat(
    structuredClone(MESSAGES),
    new AbortController().signal,
    { tools: TOOLS, ...options },
  )) {
    if (message.role === "thinking") {
      thinking += typeof message.content === "string" ? message.content : "";
    } else if (message.role === "assistant") {
      content += typeof message.content === "string" ? message.content : "";
      for (const call of message.toolCalls ?? []) {
        lastId = call.id ?? lastId;
        const entry = (toolCalls[lastId!] ??= { args: "" });
        entry.name = call.function?.name ?? entry.name;
        entry.args += call.function?.arguments ?? "";
      }
    }
  }
  return { content, thinking, toolCalls };
}

async function both(
  Llm: new (options: LLMOptions) => BaseLLM,
  options: Partial<LLMOptions>,
  chatOptions: object = {},
) {
  const results = [];
  for (const transport of ["legacy", "ai-sdk"] as const) {
    const llm = new Llm({
      model: "deepseek-v4-pro",
      apiKey: "k",
      apiBase: base,
      ...options,
      transport,
    });
    const reply = await chat(llm, chatOptions);
    results.push({ request: requests.at(-1)!, reply });
  }
  return { legacy: results[0], aiSdk: results[1] };
}

describe("core on the AI SDK transport", () => {
  it("a bridge, as provider openai", async () => {
    const { legacy, aiSdk } = await both(
      OpenAI,
      {},
      { reasoningEffort: "high" },
    );
    expect(aiSdk.request).toEqual(legacy.request);
    expect(aiSdk.reply).toEqual(legacy.reply);
    expect(aiSdk.request.path).toBe("/v1/chat/completions");
    expect(aiSdk.request.body.reasoning_effort).toBe("high");
    expect(aiSdk.reply).toEqual({
      content: "Reading it.",
      thinking: "Check a.ts.",
      toolCalls: { call_2: { name: "read_file", args: '{"path":"a.ts"}' } },
    });
  });

  it("DeepSeek on a gateway, with thinking off", async () => {
    const { legacy, aiSdk } = await both(Deepseek, {}, { thinking: "off" });
    expect(aiSdk.request).toEqual(legacy.request);
    expect(aiSdk.reply).toEqual(legacy.reply);
    expect(aiSdk.request.body.thinking).toEqual({ type: "disabled" });
  });

  it("DeepSeek through the OneProvider class", async () => {
    const { legacy, aiSdk } = await both(OneProvider, {}, { thinking: "off" });
    expect(aiSdk.request).toEqual(legacy.request);
    expect(aiSdk.reply).toEqual(legacy.reply);
    expect(aiSdk.request.body.reasoning_effort).toBe("none");
  });

  it("Claude through the OneProvider class, caching off unless asked", async () => {
    const claude = { model: "claude-sonnet-5-5" };
    const off = await both(OneProvider, claude, { reasoningEffort: "high" });
    expect(off.aiSdk.request).toEqual(off.legacy.request);
    expect(off.aiSdk.reply).toEqual(off.legacy.reply);
    expect(off.aiSdk.request.path).toBe("/v1/messages");
    expect(off.aiSdk.request.headers["x-api-key"]).toBe("k");
    expect(JSON.stringify(off.aiSdk.request)).not.toContain("cache_control");

    const on = await both(
      OneProvider,
      { ...claude, cacheBehavior: { cacheConversation: true } },
      { reasoningEffort: "high" },
    );
    expect(on.aiSdk.request).toEqual(on.legacy.request);
    expect(JSON.stringify(on.aiSdk.request.body)).toContain("cache_control");
  });
});
