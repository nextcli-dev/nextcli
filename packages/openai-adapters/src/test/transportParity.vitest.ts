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

function anthropicSse(events: object[]): any {
  const text = events
    .map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  return new NodeFetchResponse(Readable.from([Buffer.from(text)]), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** A Claude reply: signed thinking, text, a tool call in two pieces, usage */
const CLAUDE_REPLY = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude",
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 30,
        output_tokens: 1,
      },
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
    type: "content_block_start",
    index: 2,
    content_block: {
      type: "tool_use",
      id: "toolu_2",
      name: "read_file",
      input: {},
    },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: '{"path":' },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: '"a.ts"}' },
  },
  { type: "content_block_stop", index: 2 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 30 },
  },
  { type: "message_stop" },
];

/**
 * A Claude tool loop: signed and redacted thinking sent back as the
 * adapters stream it, an unsigned reasoning text (which Claude can't verify,
 * so neither transport sends it), an image
 */
const CLAUDE_CONVERSATION: any[] = [
  { role: "system", content: "You review code." },
  { role: "user", content: "Read a.ts." },
  {
    role: "assistant",
    content: "",
    reasoning_content: "I should read it.",
    reasoning_details: [
      {
        type: "reasoning.text",
        text: "I should read it.",
        signature: "sig-1",
        index: 0,
      },
      { type: "reasoning.encrypted", data: "redacted-1", index: 1 },
    ],
    tool_calls: [
      {
        id: "toolu_1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"a.ts"}' },
      },
    ],
  },
  { role: "tool", tool_call_id: "toolu_1", content: "export const a = 1;" },
  {
    role: "assistant",
    content: "It exports a.",
    reasoning_content: "Unsigned.",
  },
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
  // Beta flags are a set; their order means nothing
  if (headers["anthropic-beta"]) {
    headers["anthropic-beta"] = headers["anthropic-beta"]
      .split(",")
      .sort()
      .join(",");
  }
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

/**
 * The one difference allowed in Claude requests: the AI SDK sends fast
 * mode's beta flag with every `speed: "fast"` request, the adapter only for
 * models where fast mode is still a beta (Opus 5, 4.8). The API knows the
 * flag; it is just not needed once fast mode is generally available.
 */
const FAST_MODE_BETA = "fast-mode-2026-02-01";

function withoutFastModeBeta(
  request: ReturnType<typeof lastRequest>,
  own: ReturnType<typeof lastRequest>,
) {
  const beta = request.headers["anthropic-beta"];
  if (
    request.body?.speed !== "fast" ||
    own.headers["anthropic-beta"]?.includes(FAST_MODE_BETA) ||
    !beta?.includes(FAST_MODE_BETA)
  ) {
    return request;
  }
  const rest = beta.split(",").filter((flag) => flag !== FAST_MODE_BETA);
  const headers: Record<string, string> = { ...request.headers };
  if (rest.length > 0) headers["anthropic-beta"] = rest.join(",");
  else delete headers["anthropic-beta"];
  return { ...request, headers };
}

/** Claude on Anthropic's API, a proxy, or OneProvider's Messages endpoint */
const CLAUDE_CASES: Case[] = (
  [
    {
      name: "budget thinking from an effort (Claude 4.5)",
      config: {
        provider: "anthropic",
        apiKey: "k",
        requestOptions: REQUEST_OPTIONS,
      },
      model: "claude-sonnet-4-5",
      settings: { effort: "medium" },
    },
    {
      name: "an explicit thinking budget (Claude 4.5)",
      config: { provider: "anthropic", apiKey: "k" },
      model: "claude-sonnet-4-5",
      extra: { nextcli_thinking_budget: 3000 },
    },
    {
      name: "a top_p of 0.97 stays while thinking (Claude 4.5)",
      config: { provider: "anthropic", apiKey: "k" },
      model: "claude-sonnet-4-5",
      settings: { effort: "low" },
      extra: { top_p: 0.97 },
    },
    {
      name: "no thinking keeps temperature and top_k (Claude 4.5)",
      config: { provider: "anthropic", apiKey: "k" },
      model: "claude-sonnet-4-5",
      extra: { top_p: undefined, top_k: 40 },
    },
    {
      name: "adaptive thinking once an effort is set (Claude 4.8)",
      config: { provider: "anthropic", apiKey: "k" },
      model: "claude-opus-4-8",
      settings: { effort: "high" },
    },
    {
      name: "default thinking, shown (Claude 5.5)",
      config: { provider: "anthropic", apiKey: "k" },
      model: "claude-sonnet-5-5",
      settings: { thinking: "shown" },
    },
    {
      name: "thinking off as between_tools (Sonnet 5.5)",
      config: { provider: "anthropic", apiKey: "k" },
      model: "claude-sonnet-5-5",
      settings: { thinking: "off", effort: "medium" },
    },
    {
      name: "thinking off as disabled (Claude 4.8)",
      config: { provider: "anthropic", apiKey: "k" },
      model: "claude-opus-4-8",
      settings: { thinking: "off" },
    },
    {
      name: "fast mode (Opus 5.5)",
      config: { provider: "anthropic", apiKey: "k" },
      model: "claude-opus-5-5",
      settings: { fast: true, effort: "high" },
    },
    {
      name: "fast mode behind its beta (Opus 5)",
      config: { provider: "anthropic", apiKey: "k" },
      model: "claude-opus-5",
      settings: { fast: true },
    },
    {
      name: "a forced tool choice",
      config: { provider: "anthropic", apiKey: "k" },
      model: "claude-sonnet-5-5",
      extra: {
        tool_choice: { type: "function", function: { name: "read_file" } },
      },
    },
    {
      name: "tools without a tool choice",
      config: { provider: "anthropic", apiKey: "k" },
      model: "claude-sonnet-5-5",
      extra: { tool_choice: undefined },
    },
    {
      name: "a proxy in front of Anthropic",
      config: {
        provider: "anthropic",
        apiKey: "k",
        apiBase: "https://claude-proxy.example/v1/",
      },
      model: "claude-sonnet-5-5",
    },
    {
      name: "a Claude id no table knows yet",
      config: { provider: "anthropic", apiKey: "k" },
      model: "claude-sonnet-6",
      settings: { effort: "high" },
    },
    {
      name: "caching off",
      config: { provider: "anthropic", apiKey: "k", cachingStrategy: "none" },
      model: "claude-sonnet-5-5",
    },
    {
      name: "Claude through OneProvider with an effort",
      config: { provider: "oneprovider", apiKey: "k" },
      model: "claude-opus-5-5",
      settings: { effort: "high" },
    },
    {
      name: "a OneProvider -thinking id",
      config: { provider: "oneprovider", apiKey: "k" },
      model: "claude-sonnet-5-5-thinking",
    },
  ] satisfies Case[]
).map((c) => ({ ...c, messages: CLAUDE_CONVERSATION }));

describe("transport parity: Claude", () => {
  for (const c of CLAUDE_CASES) {
    it(c.name, async () => {
      const { legacy, aiSdk } = transports(c.config);
      const body = requestBody(c);

      const own = await sendChat(legacy, body, () =>
        anthropicSse(CLAUDE_REPLY),
      );
      const viaAiSdk = await sendChat(aiSdk, body, () =>
        anthropicSse(CLAUDE_REPLY),
      );

      expect(withoutFastModeBeta(viaAiSdk.request, own.request)).toEqual(
        own.request,
      );
      // The adapter marks every chunk "stop"; the AI-SDK path reports the
      // real reason
      expect(own.reply.finishReason).toBe("stop");
      expect(viaAiSdk.reply.finishReason).toBe("tool_calls");
      expect({ ...viaAiSdk.reply, finishReason: undefined }).toEqual({
        ...own.reply,
        finishReason: undefined,
      });
      expect(warnings).toEqual([]);
    });
  }

  it("sends Claude the request the caller built", async () => {
    const { aiSdk } = transports(CLAUDE_CASES[0].config);
    const { request, reply } = await sendChat(
      aiSdk,
      requestBody(CLAUDE_CASES[0]),
      () => anthropicSse(CLAUDE_REPLY),
    );
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers["x-api-key"]).toBe("k");
    expect(request.headers.authorization).toBeUndefined();
    // Medium is an 8,192-token budget, kept below max_tokens (4,096)
    expect(request.body.thinking).toEqual({
      type: "enabled",
      budget_tokens: 3072,
    });
    // Signed and redacted thinking go back first; the unsigned text doesn't
    expect(request.body.messages[1].content.slice(0, 2)).toEqual([
      { type: "thinking", thinking: "I should read it.", signature: "sig-1" },
      { type: "redacted_thinking", data: "redacted-1" },
    ]);
    expect(JSON.stringify(request.body)).not.toContain("Unsigned.");
    // Breakpoints: system, the last tool, the last two user turns' text
    expect(JSON.stringify(request.body).match(/cache_control/g)).toHaveLength(
      3,
    );
    expect(reply).toMatchObject({
      content: "Reading it.",
      reasoning: "Check a.ts.",
      details: [
        { type: "reasoning.text", text: "Check a.ts.", signature: "sig-2" },
      ],
      toolCalls: [
        { id: "toolu_2", name: "read_file", args: '{"path":"a.ts"}' },
      ],
      usage: { prompt: 120, completion: 30, cached: 80 },
    });
  });

  it("sends OneProvider the key only as x-api-key", async () => {
    const { aiSdk } = transports({ provider: "oneprovider", apiKey: "k" });
    const { request } = await sendChat(
      aiSdk,
      requestBody({ ...CLAUDE_CASES[0], model: "claude-opus-5-5" }),
      () => anthropicSse(CLAUDE_REPLY),
    );
    expect(request.url).toBe("https://api.oneprovider.dev/v1/messages");
    expect(request.headers["x-api-key"]).toBe("k");
    expect(request.headers.authorization).toBeUndefined();
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
