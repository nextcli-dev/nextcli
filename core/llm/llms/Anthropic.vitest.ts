import { afterEach, describe, expect, test, vi } from "vitest";
import { ILLM } from "../../index.js";
import { claudeEditPrompt } from "../templates/edit.js";
import Anthropic from "./Anthropic.js";

interface LlmTestCase {
  llm: ILLM;
  methodToTest: keyof ILLM;
  params: any[];
  expectedRequest: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: Record<string, any>;
  };
  mockResponse?: any;
  mockStream?: any[];
}

function createMockStream(mockStream: any[]) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of mockStream) {
        controller.enqueue(
          encoder.encode(
            `data: ${
              typeof chunk === "string" ? chunk : JSON.stringify(chunk)
            }\n\n`,
          ),
        );
      }
      controller.close();
    },
  });
}

function setupMockFetch(mockResponse?: any, mockStream?: any[]) {
  const mockFetch = vi.fn();

  if (mockStream) {
    const stream = createMockStream(mockStream);
    mockFetch.mockResolvedValue(
      new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
        },
      }),
    );
  } else {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  return mockFetch;
}

function setupReadableStreamPolyfill() {
  // This can be removed if https://github.com/nodejs/undici/issues/2888 is resolved
  // @ts-ignore
  const originalFrom = ReadableStream.from;
  // @ts-ignore
  ReadableStream.from = (body) => {
    if (body?.source) {
      return body;
    }
    return originalFrom(body);
  };
}

async function executeLlmMethod(
  llm: ILLM,
  methodToTest: keyof ILLM,
  params: any[],
) {
  if (typeof (llm as any)[methodToTest] !== "function") {
    throw new Error(
      `Method ${String(methodToTest)} does not exist on the LLM instance.`,
    );
  }

  const result = await (llm as any)[methodToTest](...params);
  if (result?.next) {
    for await (const _ of result) {
    }
  }
}

function assertFetchCall(mockFetch: any, expectedRequest: any) {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const [url, options] = mockFetch.mock.calls[0];

  expect(url.toString()).toBe(expectedRequest.url);
  expect(options.method).toBe(expectedRequest.method);

  if (expectedRequest.headers) {
    expect(options.headers).toEqual(
      expect.objectContaining(expectedRequest.headers),
    );
  }

  if (expectedRequest.body) {
    const actualBody = JSON.parse(options.body as string);
    expect(actualBody).toEqual(expectedRequest.body);
  }
}

async function runLlmTest(testCase: LlmTestCase) {
  const {
    llm,
    methodToTest,
    params,
    expectedRequest,
    mockResponse,
    mockStream,
  } = testCase;

  const mockFetch = setupMockFetch(mockResponse, mockStream);
  setupReadableStreamPolyfill();

  (llm as any).fetch = mockFetch;

  await executeLlmMethod(llm, methodToTest, params);
  assertFetchCall(mockFetch, expectedRequest);
}

describe("Anthropic", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("streamChat should send a valid request", async () => {
    const anthropic = new Anthropic({
      apiKey: "test-api-key",
      model: "claude-sonnet-4-5",
      apiBase: "https://api.anthropic.com/v1/",
    });

    await runLlmTest({
      llm: anthropic,
      methodToTest: "streamChat",
      params: [
        [{ role: "user", content: "hello" }],
        new AbortController().signal,
      ],
      expectedRequest: {
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": "test-api-key",
        },
        body: {
          model: "claude-sonnet-4-5",
          max_tokens: 8192,
          stream: true,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
          system: "",
        },
      },
      mockStream: [
        '{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello! How can I help you today?"}}',
        '{"type": "content_block_stop"}',
      ],
    });
  });

  test("chat should send a valid request", async () => {
    const anthropic = new Anthropic({
      apiKey: "test-api-key",
      model: "claude-sonnet-4-5",
      apiBase: "https://api.anthropic.com/v1/",
    });

    await runLlmTest({
      llm: anthropic,
      methodToTest: "chat",
      params: [
        [{ role: "user", content: "hello" }],
        new AbortController().signal,
      ],
      expectedRequest: {
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": "test-api-key",
        },
        body: {
          model: "claude-sonnet-4-5",
          max_tokens: 8192,
          stream: true,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
          system: "",
        },
      },
      mockStream: [
        '{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello! How can I help you today?"}}',
        '{"type": "content_block_stop"}',
      ],
    });
  });

  test("streamComplete should send a valid request", async () => {
    const anthropic = new Anthropic({
      apiKey: "test-api-key",
      model: "claude-sonnet-4-5",
      apiBase: "https://api.anthropic.com/v1/",
    });

    await runLlmTest({
      llm: anthropic,
      methodToTest: "streamComplete",
      params: ["Complete this: Hello", new AbortController().signal],
      expectedRequest: {
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": "test-api-key",
        },
        body: {
          model: "claude-sonnet-4-5",
          max_tokens: 8192,
          stream: true,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Complete this: Hello" }],
            },
          ],
          system: "",
        },
      },
      mockStream: [
        '{"type": "content_block_delta", "delta": {"type": "text_delta", "text": " world!"}}',
        '{"type": "content_block_stop"}',
      ],
    });
  });

  test("complete should send a valid request", async () => {
    const anthropic = new Anthropic({
      apiKey: "test-api-key",
      model: "claude-sonnet-4-5",
      apiBase: "https://api.anthropic.com/v1/",
    });

    await runLlmTest({
      llm: anthropic,
      methodToTest: "complete",
      params: ["Complete this: Hello", new AbortController().signal],
      expectedRequest: {
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": "test-api-key",
        },
        body: {
          model: "claude-sonnet-4-5",
          max_tokens: 8192,
          stream: true,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Complete this: Hello" }],
            },
          ],
          system: "",
        },
      },
      mockStream: [
        '{"type": "content_block_delta", "delta": {"type": "text_delta", "text": " world!"}}',
        '{"type": "content_block_stop"}',
      ],
    });
  });

  describe("Different configurations", () => {
    test("should handle system message", async () => {
      const anthropic = new Anthropic({
        apiKey: "test-api-key",
        model: "claude-sonnet-4-5",
        apiBase: "https://api.anthropic.com/v1/",
      });

      await runLlmTest({
        llm: anthropic,
        methodToTest: "streamChat",
        params: [
          [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "Hello!" },
          ],
          new AbortController().signal,
        ],
        expectedRequest: {
          url: "https://api.anthropic.com/v1/messages",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": "test-api-key",
          },
          body: {
            model: "claude-sonnet-4-5",
            max_tokens: 8192,
            stream: true,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "Hello!" }],
              },
            ],
            system: "You are a helpful assistant.",
          },
        },
        mockStream: [
          '{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello! How can I help you today?"}}',
          '{"type": "content_block_stop"}',
        ],
      });
    });

    test("should handle tool calls", async () => {
      const anthropic = new Anthropic({
        apiKey: "test-api-key",
        model: "claude-sonnet-4-5",
        apiBase: "https://api.anthropic.com/v1/",
      });

      const tools = [
        {
          type: "function" as const,
          function: {
            name: "get_weather",
            description: "Get the current weather",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" },
              },
              required: ["location"],
            },
          },
        },
      ];

      await runLlmTest({
        llm: anthropic,
        methodToTest: "streamChat",
        params: [
          [{ role: "user", content: "What's the weather in New York?" }],
          new AbortController().signal,
          { tools },
        ],
        expectedRequest: {
          url: "https://api.anthropic.com/v1/messages",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": "test-api-key",
          },
          body: {
            model: "claude-sonnet-4-5",
            max_tokens: 8192,
            stream: true,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "What's the weather in New York?" },
                ],
              },
            ],
            tools: [
              {
                name: "get_weather",
                description: "Get the current weather",
                input_schema: {
                  type: "object",
                  properties: {
                    location: { type: "string" },
                  },
                  required: ["location"],
                },
              },
            ],
            system: "",
          },
        },
        mockStream: [
          '{"type": "content_block_start", "content_block": {"type": "tool_use", "id": "toolu_123", "name": "get_weather"}}',
          '{"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": "{\\"location\\": \\"New York\\""}}',
          '{"type": "content_block_stop"}',
        ],
      });
    });

    test("should handle custom max tokens", async () => {
      const anthropic = new Anthropic({
        apiKey: "test-api-key",
        model: "claude-sonnet-4-5",
        apiBase: "https://api.anthropic.com/v1/",
      });

      await runLlmTest({
        llm: anthropic,
        methodToTest: "streamChat",
        params: [
          [{ role: "user", content: "hello" }],
          new AbortController().signal,
          { maxTokens: 1000 },
        ],
        expectedRequest: {
          url: "https://api.anthropic.com/v1/messages",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": "test-api-key",
          },
          body: {
            model: "claude-sonnet-4-5",
            max_tokens: 1000,
            stream: true,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "hello" }],
              },
            ],
            system: "",
          },
        },
        mockStream: [
          '{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello!"}}',
          '{"type": "content_block_stop"}',
        ],
      });
    });
  });

  describe("Error handling", () => {
    test("should throw error when API key is missing", async () => {
      const anthropic = new Anthropic({
        apiKey: "",
        model: "claude-sonnet-4-5",
        apiBase: "https://api.anthropic.com/v1/",
      });

      await expect(
        runLlmTest({
          llm: anthropic,
          methodToTest: "streamChat",
          params: [
            [{ role: "user", content: "hello" }],
            new AbortController().signal,
          ],
          expectedRequest: {
            url: "https://api.anthropic.com/v1/messages",
            method: "POST",
          },
        }),
      ).rejects.toThrow(
        "Request not sent. You have an Anthropic model configured in your config.yaml, but the API key is not set.",
      );
    });
  });
});

describe("Anthropic.convertArgs thinking and tool_choice", () => {
  const llm = new Anthropic({ apiKey: "test-api-key", model: "unused" });
  const toolChoice = {
    type: "function" as const,
    function: { name: "say_hello" },
  };

  test("uses enabled thinking with a budget for models before 4.6", () => {
    const args = llm.convertArgs({
      model: "claude-haiku-4-5-20251001",
      reasoning: true,
      reasoningBudgetTokens: 1024,
    });
    expect(args.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  test("uses adaptive thinking without a budget for 4.6 and newer", () => {
    for (const model of [
      "claude-sonnet-4-6",
      "claude-opus-4-7",
      "claude-sonnet-5-5",
    ]) {
      const args = llm.convertArgs({
        model,
        reasoning: true,
        reasoningBudgetTokens: 1024,
      });
      expect(args.thinking).toEqual({ type: "adaptive" });
    }
  });

  test("sends no thinking when reasoning is off", () => {
    expect(
      llm.convertArgs({ model: "claude-sonnet-5-5" }).thinking,
    ).toBeUndefined();
  });

  test("forces a tool for models that accept it", () => {
    const args = llm.convertArgs({ model: "claude-haiku-5-5", toolChoice });
    expect(args.tool_choice).toEqual({ type: "tool", name: "say_hello" });
  });

  test("drops a forced tool for models that reject it", () => {
    const args = llm.convertArgs({ model: "claude-sonnet-5-5", toolChoice });
    expect(args.tool_choice).toBeUndefined();
  });

  test("drops sampling params that newer models reject", () => {
    const args = llm.convertArgs({
      model: "claude-sonnet-5-5",
      temperature: 0.01,
      topP: 0.9,
      topK: 40,
    });
    expect(args.temperature).toBeUndefined();
    expect(args.top_p).toBeUndefined();
    expect(args.top_k).toBeUndefined();
  });

  test("keeps temperature but drops top_p together with it on older models", () => {
    const args = llm.convertArgs({
      model: "claude-sonnet-4-6",
      temperature: 0.5,
      topP: 0.9,
    });
    expect(args.temperature).toBe(0.5);
    expect(args.top_p).toBeUndefined();
  });

  test("drops a forced tool when thinking is on", () => {
    const args = llm.convertArgs({
      model: "claude-haiku-5-5",
      toolChoice,
      reasoning: true,
    });
    expect(args.tool_choice).toBeUndefined();
  });
});

describe("Anthropic message conversion for newer models", () => {
  const llm = new Anthropic({ apiKey: "test-api-key", model: "unused" });
  const prefilled = [
    { role: "user" as const, content: "Rewrite this code" },
    { role: "assistant" as const, content: "Sure! Here is the code:\n```ts\n" },
  ];

  test("drops an assistant prefill for models that reject it", () => {
    const messages = llm.convertMessages(prefilled, false, "claude-sonnet-5-5");
    expect(messages.map((m) => m.role)).toEqual(["user"]);
  });

  test("trims trailing whitespace from a prefill for older models", () => {
    const messages = llm.convertMessages(
      prefilled,
      false,
      "claude-haiku-4-5-20251001",
    );
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Sure! Here is the code:\n```ts" }],
    });
  });

  test("keeps thinking only for the current turn", () => {
    const thinking = (text: string) => ({
      role: "thinking" as const,
      content: text,
      signature: `sig-${text}`,
    });
    const messages = llm.convertMessages(
      [
        { role: "user", content: "First question" },
        thinking("old"),
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Second question" },
        thinking("new"),
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "file contents", toolCallId: "call_1" },
      ],
      false,
      "claude-sonnet-5-5",
    );
    const thinkingBlocks = messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "thinking");
    expect(thinkingBlocks).toEqual([
      { type: "thinking", thinking: "new", signature: "sig-new" },
    ]);
  });

  test("reports prefill support by model", () => {
    expect(
      new Anthropic({
        apiKey: "k",
        model: "claude-sonnet-5-5",
      }).supportsPrefill(),
    ).toBe(false);
    expect(
      new Anthropic({
        apiKey: "k",
        model: "claude-haiku-4-5-20251001",
      }).supportsPrefill(),
    ).toBe(true);
  });

  test("renders the edit prompt without a prefill for models that reject it", () => {
    const render = (model: string) => {
      const claude = new Anthropic({ apiKey: "k", model });
      return claude.renderPromptTemplate(claudeEditPrompt, [], {
        userInput: "add a comment",
        prefix: "",
        codeToEdit: "const a = 1;",
        suffix: "",
        language: "ts",
      }) as { role: string }[];
    };
    // The prompt without prefill is a single user prompt string
    expect(typeof render("claude-sonnet-5-5")).toBe("string");
    expect(render("claude-haiku-4-5-20251001").at(-1)?.role).toBe("assistant");
  });

  test("joins text blocks of non-streaming responses that start with thinking", async () => {
    const response = new Response(
      JSON.stringify({
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: "Hello" },
          { type: "text", text: " world" },
        ],
      }),
      { status: 200 },
    );
    const chunks = [];
    for await (const chunk of llm.handleResponse(response, false)) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ role: "assistant", content: "Hello world" }]);
  });
});
