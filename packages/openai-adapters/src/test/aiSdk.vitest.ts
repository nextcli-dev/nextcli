import { Response as NodeFetchResponse } from "node-fetch";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@nextcli/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nextcli/fetch")>()),
  fetchwithRequestOptions: vi.fn(),
}));

import { fetchwithRequestOptions } from "@nextcli/fetch";

import { AiSdkApi } from "../apis/AiSdk.js";
import { constructLlmApi } from "../index.js";
import { aiSdkFetch } from "../util.js";

const mockFetch = vi.mocked(fetchwithRequestOptions);

/** An OpenAI Chat Completions stream, as fetchwithRequestOptions returns */
function chatSse(chunks: object[]): any {
  const text =
    chunks
      .map(
        (chunk) =>
          `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", ...chunk })}\n\n`,
      )
      .join("") + "data: [DONE]\n\n";
  // Real responses stream Buffers
  return new NodeFetchResponse(Readable.from([Buffer.from(text)]), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const REPLY = [
  { choices: [{ index: 0, delta: { role: "assistant", content: "Hi." } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  {
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  },
];

function errorResponse(status: number, headers: Record<string, string> = {}) {
  return new NodeFetchResponse(
    JSON.stringify({ error: { type: "not_found_error", message: "failed" } }),
    { status, headers: { "content-type": "application/json", ...headers } },
  ) as any;
}

const ENV = ["OPENAI_API_KEY", "OPENAI_BASE_URL"];
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

/** An OpenAI-compatible gateway on the AI SDK transport */
function gateway(config: Record<string, unknown> = {}) {
  return constructLlmApi({
    provider: "openai",
    apiKey: "k",
    apiBase: "https://gateway.example/v1",
    transport: "ai-sdk",
    ...config,
  } as any)!;
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

function ask(
  api: any,
  model = "deepseek-v4-pro",
  signal = new AbortController().signal,
) {
  return drain(
    api.chatCompletionStream(
      { model, messages: [{ role: "user", content: "hi" }], stream: true },
      signal,
    ),
  );
}

describe("AiSdkApi", () => {
  it("goes through fetchwithRequestOptions, with the request options", async () => {
    mockFetch.mockResolvedValue(chatSse(REPLY));
    const requestOptions = { proxy: "http://proxy:3128", timeout: 5 };

    await ask(gateway({ requestOptions }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][2]).toEqual(requestOptions);
  });

  it("sends no environment key or host when the config has none", async () => {
    process.env.OPENAI_API_KEY = "env-key";
    process.env.OPENAI_BASE_URL = "https://elsewhere.example/v1";
    mockFetch.mockResolvedValue(chatSse(REPLY));

    await ask(
      gateway({ apiKey: undefined, apiBase: "http://127.0.0.1:8091/v1" }),
    );

    const { url, headers } = lastRequest();
    expect(url).toBe("http://127.0.0.1:8091/v1/chat/completions");
    expect(headers.get("authorization") ?? "").not.toContain("env-key");
  });

  it("sends user images", async () => {
    mockFetch.mockResolvedValue(chatSse(REPLY));
    await drain(
      gateway().chatCompletionStream(
        {
          model: "deepseek-v4-pro",
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

    expect(lastRequest().body.messages[0].content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
    });
  });

  it("streams a gateway's reasoning_details as they came, and sends them back", async () => {
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
        ...REPLY,
      ]),
    );
    const api = gateway();

    const completion = await api.chatCompletionNonStream(
      {
        model: "anthropic/claude-sonnet-5.5",
        messages: [{ role: "user", content: "hi" }],
      },
      new AbortController().signal,
    );
    const first = lastRequest();
    expect(first.url).toBe("https://gateway.example/v1/chat/completions");
    expect(first.body.stream_options).toEqual({ include_usage: true });
    const message = completion.choices[0].message as any;
    expect(message).toMatchObject({
      content: "Hi.",
      reasoning_content: "Hm.",
      reasoning_details: details,
    });
    expect(completion.usage).toMatchObject({ prompt_tokens: 12 });

    mockFetch.mockResolvedValue(chatSse(REPLY));
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
      const response = chatSse(REPLY);
      controller.abort();
      return response;
    });

    await expect(
      gateway().chatCompletionNonStream(
        {
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "hi" }],
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports an HTTP error with its status and URL", async () => {
    mockFetch.mockResolvedValue(errorResponse(404));

    await expect(ask(gateway())).rejects.toThrow(
      /^HTTP 404 from https:\/\/gateway\.example\/v1\/chat\/completions\n\n.*not_found_error/s,
    );
    // A 404 is not retried
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // The CLI's retry rules read `status` (exponentialBackoff.ts)
  it("keeps the HTTP status on the error", async () => {
    mockFetch.mockResolvedValue(errorResponse(400));
    await expect(ask(gateway())).rejects.toMatchObject({ status: 400 });
  });

  it("keeps the status of a rate limit that outlasts the SDK's retries", async () => {
    // retry-after-ms: 0 makes the SDK's own two retries immediate
    mockFetch.mockImplementation(async () =>
      errorResponse(429, { "retry-after-ms": "0" }),
    );
    await expect(ask(gateway())).rejects.toMatchObject({
      status: 429,
      message: expect.stringMatching(/^HTTP 429 from /),
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe('provider: "ai-sdk"', () => {
  it("is the vendor's config on the AI SDK transport, without the vendor in the model", async () => {
    mockFetch.mockResolvedValue(chatSse(REPLY));
    const api = constructLlmApi({
      provider: "ai-sdk",
      model: "openai/deepseek-v4-pro",
      apiKey: "k",
      apiBase: "http://127.0.0.1:8091/v1",
    } as any);
    expect(api).toBeInstanceOf(AiSdkApi);

    await ask(api, "openai/deepseek-v4-pro");

    const { url, headers, body } = lastRequest();
    expect(url).toBe("http://127.0.0.1:8091/v1/chat/completions");
    // The compatible provider's client header: the AI SDK sent it
    expect(headers.get("user-agent")).toContain("ai-sdk");
    expect(body.model).toBe("deepseek-v4-pro");
  });

  it("sends a model without a route through the vendor's own adapter", async () => {
    mockFetch.mockResolvedValue(errorResponse(400));
    const api = constructLlmApi({
      provider: "ai-sdk",
      model: "anthropic/claude-sonnet-5-5",
      apiKey: "k",
    } as any)!;

    await expect(ask(api, "anthropic/claude-sonnet-5-5")).rejects.toThrow();

    const { url, headers, body } = lastRequest();
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers.get("x-api-key")).toBe("k");
    expect(body.model).toBe("claude-sonnet-5-5");
  });

  it("rejects an unknown vendor or a model without one", () => {
    expect(() =>
      constructLlmApi({ provider: "ai-sdk", model: "acme/m" } as any),
    ).toThrow(/Unknown AI SDK provider: "acme"/);
    expect(() =>
      constructLlmApi({ provider: "ai-sdk", model: "gpt-5.5" } as any),
    ).toThrow(/<provider>\/<model>/);
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
