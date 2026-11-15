import { Response as NodeFetchResponse } from "node-fetch";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@nextcli/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nextcli/fetch")>()),
  fetchwithRequestOptions: vi.fn(),
}));

import { fetchwithRequestOptions } from "@nextcli/fetch";

import { AiSdkApi } from "../apis/AiSdk.js";
import { aiSdkFetch } from "../util.js";

const mockFetch = vi.mocked(fetchwithRequestOptions);

/** A node-fetch response, as fetchwithRequestOptions returns */
function sse(events: object[]): any {
  const text = events
    .map(
      (event) =>
        `event: ${(event as any).type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
  // Real responses stream Buffers
  return new NodeFetchResponse(Readable.from([Buffer.from(text)]), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** An OpenAI Chat Completions stream, as fetchwithRequestOptions returns */
function chatSse(chunks: object[]): any {
  const text =
    chunks
      .map(
        (chunk) =>
          `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", ...chunk })}\n\n`,
      )
      .join("") + "data: [DONE]\n\n";
  return new NodeFetchResponse(Readable.from([Buffer.from(text)]), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const CLAUDE_STREAM = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
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
    delta: { type: "thinking_delta", thinking: "Let me check." },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "sig-1" },
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
    delta: { type: "text_delta", text: "Done." },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 20 },
  },
  { type: "message_stop" },
];

const ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  mockFetch.mockReset();
});

afterEach(() => {
  for (const name of ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

function claude(config: Partial<{ apiKey: string; apiBase: string }> = {}) {
  return new AiSdkApi({
    provider: "ai-sdk",
    model: "anthropic/claude-sonnet-5-5",
    ...config,
  } as any);
}

async function drain(stream: AsyncIterable<any>) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function lastRequest() {
  const [url, init] = mockFetch.mock.calls.at(-1)!;
  const headers = new Headers(init?.headers as any);
  return { url: String(url), headers, body: JSON.parse(String(init?.body)) };
}

describe("AiSdkApi", () => {
  it("goes through fetchwithRequestOptions, with the request options", async () => {
    mockFetch.mockResolvedValue(sse(CLAUDE_STREAM));
    const requestOptions = { proxy: "http://proxy:3128", timeout: 5 };
    const api = new AiSdkApi({
      provider: "ai-sdk",
      model: "anthropic/claude-sonnet-5-5",
      apiKey: "k",
      requestOptions,
    } as any);

    await drain(
      api.chatCompletionStream(
        {
          model: "claude-sonnet-5-5",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
        new AbortController().signal,
      ),
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][2]).toEqual(requestOptions);
  });

  it("uses the configured key and the provider's own host, never the environment's", async () => {
    process.env.ANTHROPIC_API_KEY = "env-key";
    process.env.ANTHROPIC_BASE_URL = "https://elsewhere.example/v1";
    mockFetch.mockResolvedValue(sse(CLAUDE_STREAM));

    await drain(
      claude({ apiKey: "config-key" }).chatCompletionStream(
        {
          model: "claude-sonnet-5-5",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
        new AbortController().signal,
      ),
    );

    const { url, headers } = lastRequest();
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers.get("x-api-key")).toBe("config-key");
  });

  it("sends no environment key when the config has none", async () => {
    process.env.OPENAI_API_KEY = "env-key";
    process.env.OPENAI_BASE_URL = "https://elsewhere.example/v1";
    mockFetch.mockResolvedValue(
      new NodeFetchResponse(JSON.stringify({ error: { message: "no key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const api = new AiSdkApi({
      provider: "ai-sdk",
      model: "openai/gpt-5.5",
      apiBase: "http://127.0.0.1:8091/v1",
    } as any);

    await expect(
      drain(
        api.chatCompletionStream(
          {
            model: "gpt-5.5",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
          },
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow();

    const { url, headers } = lastRequest();
    expect(url.startsWith("http://127.0.0.1:8091/v1/")).toBe(true);
    expect(headers.get("authorization") ?? "").not.toContain("env-key");
  });

  it("streams Claude's reasoning with its signature, and sends it back as a thinking block", async () => {
    mockFetch.mockResolvedValue(sse(CLAUDE_STREAM));
    const chunks = await drain(
      claude({ apiKey: "k" }).chatCompletionStream(
        {
          model: "claude-sonnet-5-5",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
        new AbortController().signal,
      ),
    );

    const completion = await (
      await import("../aiSdkCompletion.js")
    ).collectChatCompletion(
      (async function* () {
        yield* chunks;
      })(),
      "claude-sonnet-5-5",
    );
    const message = completion.choices[0].message as any;
    expect(message.content).toBe("Done.");
    expect(message.reasoning_details).toEqual([
      {
        type: "reasoning.text",
        text: "Let me check.",
        signature: "sig-1",
        index: 0,
      },
    ]);
    // Cached tokens count inside prompt_tokens, and are listed apart
    expect(completion.usage).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cache_read_tokens: 80, cache_write_tokens: 10 },
    });
    expect(completion.choices[0].finish_reason).toBe("stop");

    mockFetch.mockResolvedValue(sse(CLAUDE_STREAM));
    await drain(
      claude({ apiKey: "k" }).chatCompletionStream(
        {
          model: "claude-sonnet-5-5",
          messages: [
            { role: "system", content: "Be brief." },
            { role: "user", content: "hi" },
            message,
            { role: "user", content: "and now?" },
          ],
          stream: true,
        },
        new AbortController().signal,
      ),
    );
    const { body } = lastRequest();
    expect(body.system).toEqual([{ type: "text", text: "Be brief." }]);
    expect(body.messages[1].content[0]).toEqual({
      type: "thinking",
      thinking: "Let me check.",
      signature: "sig-1",
    });
  });

  it("sends user images", async () => {
    mockFetch.mockResolvedValue(sse(CLAUDE_STREAM));
    await drain(
      claude({ apiKey: "k" }).chatCompletionStream(
        {
          model: "claude-sonnet-5-5",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "What is this?" },
                {
                  type: "image_url",
                  image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
                },
              ],
            },
          ],
          stream: true,
        },
        new AbortController().signal,
      ),
    );

    expect(lastRequest().body.messages[0].content[1]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
  });

  it("streams OpenRouter's reasoning_details as they came, and sends them back", async () => {
    const details = [
      { type: "reasoning.text", text: "Hm.", signature: "sig-or", index: 0 },
    ];
    mockFetch.mockResolvedValue(
      chatSse([
        {
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                reasoning: "Hm.",
                reasoning_details: details,
              },
            },
          ],
        },
        { choices: [{ index: 0, delta: { content: "Hi." } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        {
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        },
      ]),
    );
    const api = new AiSdkApi({
      provider: "ai-sdk",
      model: "openrouter/anthropic/claude-sonnet-5.5",
      apiKey: "k",
    } as any);

    const completion = await api.chatCompletionNonStream(
      {
        model: "anthropic/claude-sonnet-5.5",
        messages: [{ role: "user", content: "hi" }],
      },
      new AbortController().signal,
    );
    const first = lastRequest();
    expect(first.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(first.body.stream_options).toEqual({ include_usage: true });
    const message = completion.choices[0].message as any;
    expect(message).toMatchObject({
      content: "Hi.",
      reasoning_content: "Hm.",
      reasoning_details: details,
    });
    expect(completion.usage).toMatchObject({ prompt_tokens: 12 });

    mockFetch.mockResolvedValue(
      chatSse([{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]),
    );
    await api.chatCompletionNonStream(
      {
        model: "anthropic/claude-sonnet-5.5",
        messages: [
          { role: "user", content: "hi" },
          message,
          { role: "user", content: "and now?" },
        ],
      },
      new AbortController().signal,
    );
    expect(lastRequest().body.messages[1]).toMatchObject({
      role: "assistant",
      content: "Hi.",
      reasoning_content: "Hm.",
      reasoning_details: details,
    });
  });

  it("rejects a cancelled call instead of returning a finished answer", async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation(async () => {
      const response = sse(CLAUDE_STREAM);
      controller.abort();
      return response;
    });

    await expect(
      claude({ apiKey: "k" }).chatCompletionNonStream(
        {
          model: "claude-sonnet-5-5",
          messages: [{ role: "user", content: "hi" }],
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports an HTTP error with its status and URL", async () => {
    mockFetch.mockResolvedValue(
      new NodeFetchResponse(
        JSON.stringify({
          error: { type: "not_found_error", message: "Not found" },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      drain(
        claude({
          apiKey: "k",
          apiBase: "https://api.oneprovider.dev/v1",
        }).chatCompletionStream(
          {
            model: "claude-sonnet-5-5",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
          },
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(
      /^HTTP 404 from https:\/\/api\.oneprovider\.dev\/v1\/messages\n\n.*not_found_error/s,
    );
    // A 404 is not retried
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("aiSdkFetch", () => {
  it("turns a node-fetch response into a web response with the same body", async () => {
    mockFetch.mockResolvedValue(
      new NodeFetchResponse(
        Readable.from([Buffer.from("hello "), Buffer.from("world")]),
        {
          status: 201,
          statusText: "Created",
          headers: { "x-test": "1" },
        },
      ) as any,
    );

    const response = await aiSdkFetch(undefined)("https://example.test/x", {
      method: "POST",
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("1");
    expect(await response.text()).toBe("hello world");
  });

  it("throws the abort instead of returning fetchwithRequestOptions' 499", async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation(async () => {
      controller.abort();
      return new NodeFetchResponse(null, { status: 499 }) as any;
    });

    await expect(
      aiSdkFetch(undefined)("https://example.test/x", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
