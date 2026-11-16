import { Response as NodeFetchResponse } from "node-fetch";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@nextcli/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nextcli/fetch")>()),
  fetchwithRequestOptions: vi.fn(),
}));

import { fetchwithRequestOptions } from "@nextcli/fetch";

import { AiSdkApi } from "../apis/AiSdk.js";
import type { BaseLlmApi } from "../apis/base.js";
import { constructLlmApi } from "../index.js";
import {
  buildModelControlFields,
  type ModelControlSettings,
} from "../modelControls.js";

/**
 * The AI SDK transport against each provider's own adapter. The same request
 * body goes through both; the request that reaches the network and the
 * reply the caller reads must be the same. The only differences allowed are
 * the headers each HTTP client sets for itself (CLIENT_HEADERS). Any AI SDK
 * warning (a setting the SDK dropped or changed) fails the test.
 *
 * A route whose requests can't match its own adapter's stays on that adapter
 * (transport.ts aiSdkRoute).
 */

const mockFetch = vi.mocked(fetchwithRequestOptions);

/** Headers each HTTP client sets for itself */
const CLIENT_HEADERS = /^(user-agent|accept|x-stainless-.+)$/;

let warnings: unknown[] = [];
const scope = globalThis as { AI_SDK_LOG_WARNINGS?: unknown };

beforeEach(() => {
  mockFetch.mockReset();
  warnings = [];
  scope.AI_SDK_LOG_WARNINGS = (log: { warnings: unknown[] }) =>
    warnings.push(...log.warnings);
});

afterEach(() => {
  delete scope.AI_SDK_LOG_WARNINGS;
});

function sse(lines: string[]): any {
  return new NodeFetchResponse(
    Readable.from([Buffer.from(lines.map((l) => `data: ${l}\n\n`).join(""))]),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function json(value: unknown): any {
  return new NodeFetchResponse(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function chatChunks(chunks: object[]): string[] {
  return [
    ...chunks.map((chunk) =>
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        ...chunk,
      }),
    ),
    "[DONE]",
  ];
}

const delta = (value: object, finish_reason: string | null = null) => ({
  choices: [{ index: 0, delta: value, finish_reason }],
});

/**
 * A Chat Completions reply with reasoning (text and a gateway's
 * reasoning_details), text, a tool call in two pieces, and usage
 */
const CHAT_REPLY = chatChunks([
  delta({ role: "assistant", content: "" }),
  delta({ reasoning_content: "Check a.ts." }),
  delta({
    reasoning_details: [
      { type: "reasoning.encrypted", data: "opaque", index: 0, format: "x" },
    ],
  }),
  delta({ content: "Reading it." }),
  delta({
    tool_calls: [
      {
        index: 0,
        id: "call_2",
        type: "function",
        function: { name: "read_file", arguments: '{"path":' },
      },
    ],
  }),
  delta({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
  delta({}, "tool_calls"),
  {
    choices: [],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 100 },
      completion_tokens_details: { reasoning_tokens: 12 },
    },
  },
]);

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          limit: { type: "number", description: "Optional line limit" },
        },
        required: ["path"],
      },
    },
  },
];

/** A tool loop as core and the CLI send it */
const CONVERSATION: any[] = [
  { role: "system", content: "You review code." },
  { role: "user", content: "Hi." },
  { role: "assistant", content: "Hello. What should I review?" },
  { role: "user", content: "Read a.ts." },
  {
    role: "assistant",
    content: "",
    reasoning_content: "I should read it.",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"a.ts"}' },
      },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: "export const a = 1;" },
  {
    role: "user",
    content: [
      { type: "text", text: "And this one?" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
      },
    ],
  },
];

interface Case {
  name: string;
  config: Record<string, unknown>;
  model: string;
  /** Model menu settings, sent as core and the CLI send them */
  settings?: ModelControlSettings;
  /** More body fields */
  extra?: Record<string, unknown>;
  messages?: any[];
}

function requestBody(c: Case) {
  return {
    model: c.model,
    messages: c.messages ?? CONVERSATION,
    tools: TOOLS,
    tool_choice: "auto",
    max_tokens: 4096,
    temperature: 0.2,
    top_p: 0.9,
    stream: true,
    ...buildModelControlFields(
      {
        provider: String(c.config.provider),
        model: c.model,
        apiBase: c.config.apiBase as string | undefined,
      },
      c.settings ?? {},
    ),
    ...c.extra,
  };
}

/** The request as the network sees it */
function lastRequest() {
  const [url, init, requestOptions] = mockFetch.mock.calls.at(-1)!;
  const headers: Record<string, string> = {};
  new Headers(init?.headers as any).forEach((value, key) => {
    if (!CLIENT_HEADERS.test(key)) headers[key] = value;
  });
  return {
    url: String(url),
    method: init?.method ?? "GET",
    headers,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
    requestOptions,
  };
}

/**
 * What a caller reads from a streamed reply. Core and the CLI read reasoning
 * text from `reasoning_content` or `reasoning`, and merge reasoning_details
 * items by type and index into blocks.
 */
function replyOf(chunks: any[]) {
  let content = "";
  let reasoning = "";
  const blocks = new Map<string, Record<string, unknown>>();
  const toolCalls: Record<
    number,
    { id?: string; name?: string; args: string }
  > = {};
  let finishReason: string | undefined;
  let usage: any;
  for (const chunk of chunks) {
    const choice = chunk.choices?.[0];
    const d = choice?.delta ?? {};
    content += d.content ?? "";
    reasoning += d.reasoning_content ?? d.reasoning ?? "";
    for (const detail of d.reasoning_details ?? []) {
      const key = `${detail.type}/${detail.index}`;
      const block: Record<string, unknown> = blocks.get(key) ?? {
        type: detail.type,
      };
      for (const field of ["text", "signature", "data", "summary"]) {
        if (detail[field] !== undefined) {
          block[field] = `${block[field] ?? ""}${detail[field]}`;
        }
      }
      for (const field of ["id", "format"]) {
        if (detail[field] !== undefined) block[field] = detail[field];
      }
      blocks.set(key, block);
    }
    for (const call of d.tool_calls ?? []) {
      const entry = (toolCalls[call.index] ??= { args: "" });
      entry.id = call.id ?? entry.id;
      entry.name = call.function?.name ?? entry.name;
      entry.args += call.function?.arguments ?? "";
    }
    finishReason = choice?.finish_reason ?? finishReason;
    usage = chunk.usage ?? usage;
  }
  return {
    content,
    reasoning,
    details: [...blocks.values()],
    toolCalls: Object.values(toolCalls),
    finishReason,
    usage: usage && {
      prompt: usage.prompt_tokens,
      completion: usage.completion_tokens,
      cached: usage.prompt_tokens_details?.cached_tokens,
      reasoning: usage.completion_tokens_details?.reasoning_tokens,
    },
  };
}

async function sendChat(
  api: BaseLlmApi,
  body: any,
  reply: string[] | (() => any),
) {
  mockFetch.mockResolvedValueOnce(
    typeof reply === "function" ? reply() : sse(reply),
  );
  const chunks: any[] = [];
  for await (const chunk of api.chatCompletionStream(
    structuredClone(body),
    new AbortController().signal,
  )) {
    chunks.push(chunk);
  }
  return { request: lastRequest(), reply: replyOf(chunks) };
}

function transports(config: Record<string, unknown>) {
  const legacy = constructLlmApi({ ...config, transport: "legacy" } as any)!;
  const aiSdk = constructLlmApi({ ...config, transport: "ai-sdk" } as any)!;
  expect(legacy).not.toBeInstanceOf(AiSdkApi);
  expect(aiSdk).toBeInstanceOf(AiSdkApi);
  return { legacy, aiSdk };
}

const REQUEST_OPTIONS = {
  headers: { "X-Team": "review" },
  extraBodyProperties: { metadata: { run: "1" } },
  timeout: 30,
};

/** OpenAI-compatible endpoints that aren't OpenAI's own */
const COMPATIBLE_CASES: Case[] = [
  {
    name: "a bridge on this machine, with a parameter only it knows",
    config: {
      provider: "openai",
      apiKey: "k",
      apiBase: "http://127.0.0.1:8091/v1/",
      requestOptions: REQUEST_OPTIONS,
    },
    model: "deepseek-v4-pro",
    extra: { bridge_param: { keep: true } },
  },
  {
    name: "Claude through a bridge keeps Anthropic's sampling limits",
    config: {
      provider: "openai",
      apiKey: "k",
      apiBase: "http://127.0.0.1:8091/v1",
    },
    model: "claude-sonnet-5-5",
  },
  {
    name: "a reasoning OpenAI model through a gateway gets no sampling",
    config: {
      provider: "openai",
      apiKey: "k",
      apiBase: "https://gateway.example/v1",
    },
    model: "gpt-5.5",
  },
  {
    name: "DeepSeek through OneProvider with thinking off",
    config: { provider: "oneprovider", apiKey: "k" },
    model: "deepseek-v4-pro",
    settings: { thinking: "off" },
  },
  {
    name: "GPT through OneProvider with an effort",
    config: { provider: "oneprovider", apiKey: "k" },
    model: "gpt-5.5",
    settings: { effort: "high" },
  },
  {
    // What nextcli-checks writes
    name: "an openai config on OneProvider, DeepSeek with thinking off",
    config: {
      provider: "openai",
      apiKey: "k",
      apiBase: "https://api.oneprovider.dev/v1",
    },
    model: "deepseek-v4-pro",
    settings: { thinking: "off" },
  },
  {
    // Core sends tools without a tool_choice
    name: "tools without a tool choice",
    config: {
      provider: "openai",
      apiKey: "k",
      apiBase: "http://127.0.0.1:8091/v1",
    },
    model: "deepseek-v4-pro",
    extra: { tool_choice: undefined },
  },
  {
    // Core sends reasoning_content: "" on assistant messages for DeepSeek
    name: "an empty reasoning_content the caller sent stays",
    config: { provider: "oneprovider", apiKey: "k" },
    model: "deepseek-v4-pro",
    messages: CONVERSATION.map((message) =>
      message.role === "assistant" && message.reasoning_content === undefined
        ? { ...message, reasoning_content: "" }
        : message,
    ),
  },
  {
    name: "provider deepseek on a gateway fills empty reasoning_content",
    config: {
      provider: "deepseek",
      apiKey: "k",
      apiBase: "https://gateway.example/v1",
    },
    model: "deepseek-v4-pro",
  },
];

describe("transport parity: OpenAI-compatible endpoints", () => {
  for (const c of COMPATIBLE_CASES) {
    it(c.name, async () => {
      const { legacy, aiSdk } = transports(c.config);
      const body = requestBody(c);

      const own = await sendChat(legacy, body, CHAT_REPLY);
      const viaAiSdk = await sendChat(aiSdk, body, CHAT_REPLY);

      expect(viaAiSdk.request).toEqual(own.request);
      expect(viaAiSdk.reply).toEqual(own.reply);
      expect(warnings).toEqual([]);
    });
  }

  it("sends the request the caller built, field for field", async () => {
    // Guards the cases above against comparing two empty requests
    const { aiSdk } = transports(COMPATIBLE_CASES[0].config);
    const { request, reply } = await sendChat(
      aiSdk,
      requestBody(COMPATIBLE_CASES[0]),
      CHAT_REPLY,
    );
    expect(request.url).toBe("http://127.0.0.1:8091/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer k");
    expect(request.requestOptions).toEqual(REQUEST_OPTIONS);
    expect(request.body.bridge_param).toEqual({ keep: true });
    expect(request.body.messages[4]).toMatchObject({
      content: "",
      reasoning_content: "I should read it.",
    });
    // An optional tool parameter stays optional
    expect(request.body.tools[0].function.parameters.required).toEqual([
      "path",
    ]);
    expect(reply).toMatchObject({
      content: "Reading it.",
      reasoning: "Check a.ts.",
      toolCalls: [{ id: "call_2", name: "read_file", args: '{"path":"a.ts"}' }],
      finishReason: "tool_calls",
      usage: { prompt: 120, completion: 30, cached: 100, reasoning: 12 },
    });
  });

  it("sends requests other than chat through the provider's own adapter", async () => {
    const config = COMPATIBLE_CASES[0].config;
    const { legacy, aiSdk } = transports(config);
    const requests = [];
    for (const api of [legacy, aiSdk]) {
      mockFetch.mockResolvedValueOnce(json({ object: "list", data: [] }));
      await api.list();
      const list = lastRequest();
      mockFetch.mockResolvedValueOnce(
        json({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.1] }],
          model: "e",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      );
      await api.embed({ model: "e", input: "hello" });
      requests.push({ list, embed: lastRequest() });
    }
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0].list.url).toBe("http://127.0.0.1:8091/v1/models");
  });
});

describe("transport selection", () => {
  it("keeps the provider's own adapter for a provider without AI-SDK routes", () => {
    expect(
      constructLlmApi({
        provider: "gemini",
        apiKey: "k",
        transport: "ai-sdk",
      } as any),
    ).not.toBeInstanceOf(AiSdkApi);
  });

  it("sends a model without a route through the provider's own adapter", async () => {
    // OpenAI's own API has no AI-SDK route yet
    const { legacy, aiSdk } = transports({ provider: "openai", apiKey: "k" });
    const body = requestBody({
      name: "",
      config: { provider: "openai" },
      model: "gpt-4.1",
    });
    const own = await sendChat(legacy, body, CHAT_REPLY);
    const viaAiSdk = await sendChat(aiSdk, body, CHAT_REPLY);
    expect(viaAiSdk.request).toEqual(own.request);
    expect(viaAiSdk.reply).toEqual(own.reply);
  });
});
