import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.mjs";
import { vi } from "vitest";

import { ToolCall } from "../tools/index.js";
import { traceEvent } from "../trace/trace.js";

import { preprocessStreamedToolCalls } from "./streamChatResponse.helpers.js";
import { processStreamingResponse } from "./streamChatResponse.js";

vi.mock("../trace/trace.js", () => ({ traceEvent: vi.fn() }));

// Test the chunk processing logic that was identified as buggy
describe("processStreamingResponse - content preservation", () => {
  // Mock dependencies
  let mockLlmApi: BaseLlmApi;
  let mockAbortController: AbortController;
  let mockModel: ModelConfig;
  let chunks: ChatCompletionChunk[];
  let chatHistory: ChatHistoryItem[];

  // Helper to create a content chunk
  function contentChunk(content: string): ChatCompletionChunk {
    return {
      id: "test",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: null,
        },
      ],
    };
  }

  // Helper to create a tool call chunk
  function toolCallChunk(
    id: string,
    name?: string,
    args?: string,
  ): ChatCompletionChunk {
    return {
      id: "test",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: {
                  name: name || undefined,
                  arguments: args || undefined,
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
  }

  // Helper to create a tool call chunk with optional ID
  function toolCallChunkWithIndex(
    index: number,
    id?: string,
    name?: string,
    args?: string,
  ): ChatCompletionChunk {
    const toolCall: any = {
      index,
      type: "function" as const,
      function: {},
    };

    if (id) toolCall.id = id;
    if (name) toolCall.function.name = name;
    if (args !== undefined) toolCall.function.arguments = args;

    return {
      id: "test",
      object: "chat.completion.chunk" as const,
      created: Date.now(),
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [toolCall] },
          finish_reason: null,
        },
      ],
    };
  }

  beforeEach(() => {
    // Reset chunks for each test
    chunks = [];
    chatHistory = [
      {
        message: { role: "user", content: "Test prompt" },
        contextItems: [],
      },
    ];

    // Create a mock LLM API that returns our predefined chunks
    mockLlmApi = {
      chatCompletionStream: vi.fn().mockImplementation(async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      }),
    } as unknown as BaseLlmApi;

    // Mock abort controller
    mockAbortController = {
      signal: { aborted: false },
    } as unknown as AbortController;

    // Mock model config
    mockModel = {
      model: "test-model",
      provider: "test-provider",
    } as unknown as ModelConfig;
  });

  it("content after tool calls is preserved", async () => {
    chunks = [
      contentChunk(""),
      toolCallChunk("call_123", "Read", '{"filepath": "/README.md"}'),
      contentChunk(""),
      contentChunk("I'll read the README file for you."),
    ];

    const result = await processStreamingResponse({
      chatHistory,
      model: mockModel,
      llmApi: mockLlmApi,
      abortController: mockAbortController,
      systemMessage: "You are a helpful assistant.",
    });

    expect(result.content).toBe("I'll read the README file for you.");
    expect(result.toolCalls.length).toBe(1);

    // Fixed: finalContent should preserve the content
    expect(result.finalContent).toBe("I'll read the README file for you.");
  });

  it("content before tool calls is preserved", async () => {
    chunks = [
      contentChunk("Let me search for that. "),
      toolCallChunk("call_123", "search_code", '{"pattern": "test"}'),
    ];

    const result = await processStreamingResponse({
      chatHistory,
      model: mockModel,
      llmApi: mockLlmApi,
      abortController: mockAbortController,
      systemMessage: "You are a helpful assistant.",
    });

    expect(result.content).toBe("Let me search for that. ");
    expect(result.toolCalls.length).toBe(1);

    // Fixed: finalContent preserves content before tool calls
    expect(result.finalContent).toBe("Let me search for that. ");
  });

  it("handles the exact problematic sequence from the logs", async () => {
    chunks = [
      contentChunk(""),
      toolCallChunk("toolu_vrtx_01Jj9m9VbtwVZwcU6A311g6A", "Read", ""),
      toolCallChunk(
        "toolu_vrtx_01Jj9m9VbtwVZwcU6A311g6A",
        undefined,
        '{"filepath',
      ),
      toolCallChunk(
        "toolu_vrtx_01Jj9m9VbtwVZwcU6A311g6A",
        undefined,
        '": "/Use',
      ),
      toolCallChunk(
        "toolu_vrtx_01Jj9m9VbtwVZwcU6A311g6A",
        undefined,
        "rs/nate/gh/c",
      ),
      toolCallChunk(
        "toolu_vrtx_01Jj9m9VbtwVZwcU6A311g6A",
        undefined,
        "ontinuede",
      ),
      toolCallChunk(
        "toolu_vrtx_01Jj9m9VbtwVZwcU6A311g6A",
        undefined,
        "v/cli/README",
      ),
      toolCallChunk("toolu_vrtx_01Jj9m9VbtwVZwcU6A311g6A", undefined, '.md"}'),
      contentChunk(""),
      contentChunk("I'll read the README file for you."),
    ];

    const result = await processStreamingResponse({
      chatHistory,
      model: mockModel,
      llmApi: mockLlmApi,
      abortController: mockAbortController,
      systemMessage: "You are a helpful assistant.",
    });

    expect(result.content).toBe("I'll read the README file for you.");
    expect(result.toolCalls.length).toBe(1);

    // Fixed: content is preserved
    expect(result.finalContent).toBe("I'll read the README file for you.");

    // Verify the tool call was assembled correctly
    expect(result.toolCalls[0].name).toBe("Read");
    expect(result.toolCalls[0].argumentsStr).toBe(
      '{"filepath": "/Users/nate/gh/continuedev/cli/README.md"}',
    );
  });

  it("shows content works fine without tool calls", async () => {
    chunks = [contentChunk("Hello "), contentChunk("world!")];

    const result = await processStreamingResponse({
      chatHistory,
      model: mockModel,
      llmApi: mockLlmApi,
      abortController: mockAbortController,
      systemMessage: "You are a helpful assistant.",
    });

    expect(result.content).toBe("Hello world!");
    expect(result.toolCalls.length).toBe(0);

    // Without tool calls, finalContent is correct
    expect(result.finalContent).toBe("Hello world!");
  });

  it("leaves Responses API routing for gpt-5 models to the adapter and preserves streaming tool updates", async () => {
    const gpt5Chunks: ChatCompletionChunk[] = [
      {
        id: "resp_gpt5",
        object: "chat.completion.chunk",
        created: Date.now(),
        model: "gpt-5",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "resp_gpt5",
        object: "chat.completion.chunk",
        created: Date.now(),
        model: "gpt-5",
        choices: [
          {
            index: 0,
            delta: { content: "Analyzing repository…" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "resp_gpt5",
        object: "chat.completion.chunk",
        created: Date.now(),
        model: "gpt-5",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_final",
                  type: "function",
                  function: {
                    name: "searchDocs",
                    arguments: '{"query":"unit',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "resp_gpt5",
        object: "chat.completion.chunk",
        created: Date.now(),
        model: "gpt-5",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: "function",
                  function: {
                    arguments: ' tests"}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "resp_gpt5",
        object: "chat.completion.chunk",
        created: Date.now(),
        model: "gpt-5",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "tool_calls",
          },
        ],
      },
    ];

    // OpenAIApi.chatCompletionStream switches to the Responses API itself
    const chatCompletionStream = vi.fn().mockImplementation(async function* () {
      for (const chunk of gpt5Chunks) {
        yield chunk;
      }
    });
    const responsesStream = vi.fn().mockImplementation(async function* () {
      throw new Error("responsesStream should not be called directly");
    });

    mockLlmApi = {
      responsesStream,
      chatCompletionStream,
    } as unknown as BaseLlmApi;

    mockModel = {
      model: "gpt-5-preview",
      provider: "openai",
    } as unknown as ModelConfig;

    const result = await processStreamingResponse({
      chatHistory,
      model: mockModel,
      llmApi: mockLlmApi,
      abortController: mockAbortController,
      systemMessage: "You are a helpful assistant.",
    });

    expect(chatCompletionStream).toHaveBeenCalledTimes(1);
    expect(responsesStream).not.toHaveBeenCalled();
    expect(result.content).toBe("Analyzing repository…");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: "call_final",
      name: "searchDocs",
      arguments: { query: "unit tests" },
    });
    expect(result.shouldContinue).toBe(true);
  });

  // #12626: some providers reuse a tool call id and always send index 0
  it("keeps two calls apart when a provider reuses the same id", async () => {
    chunks = [
      toolCallChunkWithIndex(0, "toolu_dup", "Read", '{"filepath":"a.ts"}'),
      toolCallChunkWithIndex(0, "toolu_dup", "Read", '{"filepath":"b.ts"}'),
    ];

    const result = await processStreamingResponse({
      chatHistory,
      model: mockModel,
      llmApi: mockLlmApi,
      abortController: mockAbortController,
      systemMessage: "You are a helpful assistant.",
    });

    expect(result.toolCalls.map((tc) => tc.argumentsStr)).toEqual([
      '{"filepath":"a.ts"}',
      '{"filepath":"b.ts"}',
    ]);
  });

  it("handles provider that only sends tool ID in first chunk then uses index", async () => {
    chunks = [
      contentChunk("I'll read the README.md file for you and then say hello!"),
      // First chunk has ID
      toolCallChunkWithIndex(
        0,
        "toolu_vrtx_01ULx6UjdJ7B7bjf5WPHTXGz",
        "Read",
        "",
      ),
      // Subsequent chunks only have index, no ID
      toolCallChunkWithIndex(
        0,
        undefined,
        undefined,
        '{"filepath": "/Users/nate/gh/continuedev/cli/README.md"}',
      ),
    ];

    const result = await processStreamingResponse({
      chatHistory,
      model: mockModel,
      llmApi: mockLlmApi,
      abortController: mockAbortController,
      systemMessage: "You are a helpful assistant.",
    });

    // Content is captured correctly
    expect(result.content).toBe(
      "I'll read the README.md file for you and then say hello!",
    );
    expect(result.toolCalls.length).toBe(1);

    // Fixed: finalContent preserves content
    expect(result.finalContent).toBe(
      "I'll read the README.md file for you and then say hello!",
    );

    // Tool call arguments are preserved using index mapping
    expect(result.toolCalls[0].name).toBe("Read");
    expect(result.toolCalls[0].argumentsStr).toBe(
      '{"filepath": "/Users/nate/gh/continuedev/cli/README.md"}',
    );
  });

  it("handles realistic fragmented arguments from index-based provider", async () => {
    // Simulate the exact sequence from the user's logs with fragmented JSON
    chunks = [
      contentChunk("I'll read the README.md file for you and then say hello!"),
      // First chunk has ID
      toolCallChunkWithIndex(
        0,
        "toolu_vrtx_01ULx6UjdJ7B7bjf5WPHTXGz",
        "Read",
        "",
      ),
      // Subsequent chunks fragment the JSON arguments
      toolCallChunkWithIndex(0, undefined, undefined, '{"filepa'),
      toolCallChunkWithIndex(0, undefined, undefined, 'th"'),
      toolCallChunkWithIndex(0, undefined, undefined, ": "),
      toolCallChunkWithIndex(0, undefined, undefined, '"/U'),
      toolCallChunkWithIndex(0, undefined, undefined, "sers/nate/gh"),
      toolCallChunkWithIndex(0, undefined, undefined, "/c"),
      toolCallChunkWithIndex(0, undefined, undefined, "onti"),
      toolCallChunkWithIndex(0, undefined, undefined, "nuedev/cli"),
      toolCallChunkWithIndex(0, undefined, undefined, "/READ"),
      toolCallChunkWithIndex(0, undefined, undefined, "ME.m"),
      toolCallChunkWithIndex(0, undefined, undefined, 'd"}'),
    ];

    const result = await processStreamingResponse({
      chatHistory,
      model: mockModel,
      llmApi: mockLlmApi,
      abortController: mockAbortController,
      systemMessage: "You are a helpful assistant.",
    });

    // Fixed: Both issues are resolved
    // 1. Content is preserved
    expect(result.finalContent).toBe(
      "I'll read the README.md file for you and then say hello!",
    );

    // 2. Tool call arguments are assembled correctly
    expect(result.toolCalls[0].name).toBe("Read");
    expect(result.toolCalls[0].argumentsStr).toBe(
      '{"filepath": "/Users/nate/gh/continuedev/cli/README.md"}',
    );
  });

  it("traces how each call ended", async () => {
    chunks = [
      contentChunk("Hello"),
      {
        ...contentChunk(""),
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
      },
      {
        ...contentChunk(""),
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 32000,
          total_tokens: 32010,
        },
      },
    ];

    await processStreamingResponse({
      chatHistory,
      model: mockModel,
      llmApi: mockLlmApi,
      abortController: mockAbortController,
      systemMessage: "You are a helpful assistant.",
    });

    expect(traceEvent).toHaveBeenCalledWith(
      "llm.request",
      expect.objectContaining({
        model: "test-model",
        finishReason: "length",
        contentChars: 5,
        reasoningChars: 0,
        toolCalls: [],
        usage: expect.objectContaining({ completion_tokens: 32000 }),
      }),
      { ts: expect.any(Number), dur: expect.any(Number) },
    );
  });

  it.each([
    ["reasoning_content", { reasoning_content: "thinking it over" }],
    [
      "reasoning_details",
      {
        reasoning_details: [
          { type: "reasoning.text", text: "thinking it over", index: 0 },
        ],
      },
    ],
  ])(
    "traces a call cut off while thinking (%s)",
    async (_field, delta: any) => {
      chunks = [
        { ...contentChunk(""), choices: [{ index: 0, delta } as any] },
        {
          ...contentChunk(""),
          choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        },
      ];

      await processStreamingResponse({
        chatHistory,
        model: mockModel,
        llmApi: mockLlmApi,
        abortController: mockAbortController,
        systemMessage: "You are a helpful assistant.",
      });

      expect(traceEvent).toHaveBeenLastCalledWith(
        "llm.request",
        expect.objectContaining({
          finishReason: "length",
          contentChars: 0,
          reasoningChars: "thinking it over".length,
          ttftMs: expect.any(Number),
        }),
        expect.anything(),
      );
    },
  );

  it("traces a call that dies after its first chunk once, as discarded", async () => {
    vi.mocked(traceEvent).mockClear();
    mockLlmApi.chatCompletionStream = vi.fn(async function* () {
      yield {
        ...contentChunk(""),
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 },
      };
      throw Object.assign(new Error("Bad request"), { status: 400 });
    }) as any;

    await expect(
      processStreamingResponse({
        chatHistory,
        model: mockModel,
        llmApi: mockLlmApi,
        abortController: mockAbortController,
        systemMessage: "You are a helpful assistant.",
      }),
    ).rejects.toThrow("Bad request");

    expect(traceEvent).toHaveBeenCalledTimes(1);
    expect(traceEvent).toHaveBeenCalledWith(
      "llm.request",
      expect.objectContaining({
        discarded: true,
        error: "Bad request",
        finishReason: "length",
        usage: expect.objectContaining({ completion_tokens: 50 }),
      }),
      expect.anything(),
    );
  });

  it("marks a call the user stopped mid-stream as aborted", async () => {
    chunks = [contentChunk("Hel"), contentChunk("lo")];
    const signal = mockAbortController.signal as { aborted: boolean };

    await processStreamingResponse({
      chatHistory,
      model: mockModel,
      llmApi: mockLlmApi,
      abortController: mockAbortController,
      systemMessage: "You are a helpful assistant.",
      callbacks: {
        onContent: () => {
          signal.aborted = true;
        },
      },
    });

    expect(traceEvent).toHaveBeenLastCalledWith(
      "llm.request",
      expect.objectContaining({ aborted: true, contentChars: 3 }),
      expect.anything(),
    );
  });

  it("traces a call that fails before its first chunk", async () => {
    mockLlmApi.chatCompletionStream = vi.fn(async function* () {
      throw Object.assign(new Error("Bad request"), { status: 400 });
    }) as any;

    await expect(
      processStreamingResponse({
        chatHistory,
        model: mockModel,
        llmApi: mockLlmApi,
        abortController: mockAbortController,
        systemMessage: "You are a helpful assistant.",
      }),
    ).rejects.toThrow("Bad request");

    expect(traceEvent).toHaveBeenCalledWith(
      "llm.request",
      {
        model: "test-model",
        error: "Bad request",
        status: 400,
        aborted: false,
      },
      { ts: expect.any(Number), dur: expect.any(Number) },
    );
  });

  it("handles malformed chunk with empty choices array without crashing", async () => {
    // This reproduces the exact bug from the logs:
    // {"chunk":{"choices":[],"usage":{"completion_tokens":96,"prompt_tokens":711,"total_tokens":807,"prompt_tokens_details":{"cached_tokens":3353}},"created":1754927672408,"id":"","model":"claude-sonnet-4-20250514","object":"chat.completion.chunk"}}
    const malformedChunk: ChatCompletionChunk = {
      id: "",
      object: "chat.completion.chunk",
      created: 1754927672408,
      model: "claude-sonnet-4-20250514",
      choices: [], // Empty choices array - this causes the bug
      usage: {
        completion_tokens: 96,
        prompt_tokens: 711,
        total_tokens: 807,
        prompt_tokens_details: {
          cached_tokens: 3353,
        },
      },
    };

    chunks = [
      malformedChunk, // Put malformed chunk first to trigger the bug more clearly
      contentChunk("Hello "),
      contentChunk("world!"),
    ];

    // This should not throw an error: "Cannot read properties of undefined (reading 'delta')"
    let caughtError: any = null;
    try {
      await processStreamingResponse({
        chatHistory,
        model: mockModel,
        llmApi: mockLlmApi,
        abortController: mockAbortController,
        systemMessage: "You are a helpful assistant.",
      });
    } catch (error) {
      caughtError = error;
    }

    // Should NOT throw error about reading 'delta' property
    expect(caughtError).toBeNull();

    const result = await processStreamingResponse({
      chatHistory,
      model: mockModel,
      llmApi: mockLlmApi,
      abortController: mockAbortController,
      systemMessage: "You are a helpful assistant.",
    });

    expect(result.content).toBe("Hello world!");
    expect(result.toolCalls.length).toBe(0);
    expect(result.finalContent).toBe("Hello world!");
  });
});

// Tests for preprocessStreamedToolCalls function
describe.skip("preprocessStreamedToolCalls", () => {
  // Mock dependencies
  beforeEach(async () => {
    // Mock setup would go here but is currently causing issues
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preprocesses valid tool calls correctly", async () => {
    const toolCalls: ToolCall[] = [
      {
        id: "call_123",
        name: "Read",
        arguments: { filepath: "/path/to/file.txt" },
        argumentsStr: '{"filepath": "/path/to/file.txt"}',
        startNotified: false,
      },
    ];

    const callbacks = {
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
    };

    const { preprocessedCalls, errorChatEntries } =
      await preprocessStreamedToolCalls(true, toolCalls, callbacks);

    // Should have one preprocessed call and no errors
    expect(preprocessedCalls).toHaveLength(1);
    expect(errorChatEntries).toHaveLength(0);
    expect(preprocessedCalls[0].name).toBe("Read");
    expect(preprocessedCalls[0].tool).toBeDefined();
    expect(preprocessedCalls[0].preprocessResult).toBeDefined();

    // Callbacks should not be called for successful preprocessing
    expect(callbacks.onToolStart).not.toHaveBeenCalled();
    expect(callbacks.onToolError).not.toHaveBeenCalled();
  });

  it("handles tool preprocessing errors correctly", async () => {
    // Set the spy to throw an error
    const toolsModule = await import("../tools/index.js");
    vi.spyOn(toolsModule, "validateToolCallArgsPresent").mockImplementationOnce(
      () => {
        throw new Error("Missing required argument");
      },
    );

    const toolCalls: ToolCall[] = [
      {
        id: "call_456",
        name: "Read",
        arguments: {}, // Missing required filepath
        argumentsStr: "{}",
        startNotified: false,
      },
    ];

    const callbacks = {
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
    };

    const { preprocessedCalls, errorChatEntries } =
      await preprocessStreamedToolCalls(true, toolCalls, callbacks);

    // Should have no preprocessed calls and one error
    expect(preprocessedCalls).toHaveLength(0);
    expect(errorChatEntries).toHaveLength(1);
    expect(errorChatEntries[0].content).toContain("Missing required argument");

    // Callbacks should be called for errors
    expect(callbacks.onToolStart).toHaveBeenCalledWith("Read", {});
    expect(callbacks.onToolError).toHaveBeenCalledWith(
      expect.stringContaining("Missing required argument"),
      "Read",
    );
  });

  it("handles tool not found errors", async () => {
    const toolCalls: ToolCall[] = [
      {
        id: "call_789",
        name: "nonexistent_tool",
        arguments: { some: "arg" },
        argumentsStr: '{"some": "arg"}',
        startNotified: false,
      },
    ];

    const { preprocessedCalls, errorChatEntries } =
      await preprocessStreamedToolCalls(true, toolCalls);

    // Should have no preprocessed calls and one error
    expect(preprocessedCalls).toHaveLength(0);
    expect(errorChatEntries).toHaveLength(1);
    expect(errorChatEntries[0].content).toContain(
      "Tool nonexistent_tool not found",
    );
  });
});

// executeStreamedToolCalls is covered in streamChatResponse.executeToolCalls.test.ts
