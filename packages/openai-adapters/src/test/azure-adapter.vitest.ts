import { afterEach, describe, expect, test, vi } from "vitest";
import { constructLlmApi } from "../index.js";
import { runAdapterTest } from "./adapter-test-utils.js";

// Mock the fetch package (the OpenAI client is stubbed directly, but the
// shared test helper also patches this module).
vi.mock("@continuedev/fetch", async () => {
  const actual = await vi.importActual("@continuedev/fetch");
  return {
    ...actual,
    fetchwithRequestOptions: vi.fn(),
  };
});

const API_VERSION = "2024-02-15-preview";
const AZURE_OPENAI_CHAT_URL = `https://test.openai.azure.com/openai/deployments/gpt-4.1/chat/completions?api-version=${API_VERSION}`;

const headers = {
  authorization: "Bearer test-api-key",
  "content-type": "application/json",
  accept: "application/json",
};

const azureOpenAIConfig = {
  provider: "azure" as const,
  apiKey: "test-api-key",
  apiBase: "https://test.openai.azure.com",
  env: {
    deployment: "gpt-4.1",
    apiType: "azure-openai" as const,
    apiVersion: API_VERSION,
  },
};

const chatResponse = {
  id: "test-id",
  object: "chat.completion",
  created: 1234567890,
  model: "gpt-4.1",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello" },
      finish_reason: "stop",
    },
  ],
};

describe("Azure Adapter", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  test("azure-openai chat uses the deployment path, api-version, and bearer auth", async () => {
    await runAdapterTest({
      config: azureOpenAIConfig,
      methodToTest: "chatCompletionNonStream",
      params: [
        {
          model: "gpt-4.1",
          messages: [{ role: "user", content: "hello" }],
        },
        new AbortController().signal,
      ],
      expectedRequest: {
        url: AZURE_OPENAI_CHAT_URL,
        method: "POST",
        headers,
        body: {
          model: "gpt-4.1",
          messages: [{ role: "user", content: "hello" }],
        },
      },
      mockResponse: chatResponse,
    });
  });

  test("streaming drops content-filter chunks that have no choices", async () => {
    const chunks = await runAdapterTest({
      config: azureOpenAIConfig,
      methodToTest: "chatCompletionStream",
      params: [
        {
          model: "gpt-4.1",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        },
        new AbortController().signal,
      ],
      expectedRequest: {
        url: AZURE_OPENAI_CHAT_URL,
        method: "POST",
        headers,
        body: {
          model: "gpt-4.1",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
          stream_options: { include_usage: true },
        },
      },
      mockStream: [
        {
          id: "test-id",
          object: "chat.completion.chunk",
          created: 1234567890,
          model: "gpt-4.1",
          choices: [],
          prompt_filter_results: [
            { prompt_index: 0, content_filter_results: {} },
          ],
        },
        {
          id: "test-id",
          object: "chat.completion.chunk",
          created: 1234567890,
          model: "gpt-4.1",
          choices: [
            { index: 0, delta: { content: "Hello" }, finish_reason: null },
          ],
        },
        {
          id: "test-id",
          object: "chat.completion.chunk",
          created: 1234567890,
          model: "gpt-4.1",
          choices: [
            { index: 0, delta: { content: " world" }, finish_reason: null },
          ],
        },
      ],
    });

    expect(
      chunks.map(
        (chunk) =>
          (chunk as { choices?: { delta?: { content?: string } }[] })
            .choices?.[0]?.delta?.content,
      ),
    ).toEqual(["Hello", " world"]);
  });

  test("empty text content parts are removed from the request", async () => {
    await runAdapterTest({
      config: azureOpenAIConfig,
      methodToTest: "chatCompletionNonStream",
      params: [
        {
          model: "gpt-4.1",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "" },
                { type: "text", text: "hello" },
              ],
            },
          ],
        },
        new AbortController().signal,
      ],
      expectedRequest: {
        url: AZURE_OPENAI_CHAT_URL,
        method: "POST",
        headers,
        body: {
          model: "gpt-4.1",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
      },
      mockResponse: chatResponse,
    });
  });

  test("query parameters already on apiBase are kept and api-version is added", async () => {
    await runAdapterTest({
      config: {
        ...azureOpenAIConfig,
        apiBase: "https://test.openai.azure.com/?foo=bar",
      },
      methodToTest: "chatCompletionNonStream",
      params: [
        {
          model: "gpt-4.1",
          messages: [{ role: "user", content: "hello" }],
        },
        new AbortController().signal,
      ],
      expectedRequest: {
        url: `https://test.openai.azure.com/openai/deployments/gpt-4.1/chat/completions?foo=bar&api-version=${API_VERSION}`,
        method: "POST",
        headers,
        body: {
          model: "gpt-4.1",
          messages: [{ role: "user", content: "hello" }],
        },
      },
      mockResponse: chatResponse,
    });
  });

  test("azure-foundry does not insert a deployment path", async () => {
    // api-version is only added for azure-openai / legacy azure, not foundry.
    await runAdapterTest({
      config: {
        provider: "azure",
        apiKey: "test-api-key",
        apiBase: "https://test.services.ai.azure.com/models",
        env: {
          apiType: "azure-foundry",
          apiVersion: API_VERSION,
        },
      },
      methodToTest: "chatCompletionNonStream",
      params: [
        {
          model: "mistral-small",
          messages: [{ role: "user", content: "hello" }],
        },
        new AbortController().signal,
      ],
      expectedRequest: {
        url: "https://test.services.ai.azure.com/models/chat/completions",
        method: "POST",
        headers,
        body: {
          model: "mistral-small",
          messages: [{ role: "user", content: "hello" }],
        },
      },
      mockResponse: chatResponse,
    });
  });

  test("embeddings use the deployment path and api-version", async () => {
    await runAdapterTest({
      config: {
        ...azureOpenAIConfig,
        env: {
          deployment: "embed-deploy",
          apiType: "azure-openai",
          apiVersion: API_VERSION,
        },
      },
      methodToTest: "embed",
      params: [
        {
          model: "text-embedding-3-small",
          input: ["Hello", "World"],
        },
      ],
      expectedRequest: {
        url: `https://test.openai.azure.com/openai/deployments/embed-deploy/embeddings?api-version=${API_VERSION}`,
        method: "POST",
        headers,
        body: {
          model: "text-embedding-3-small",
          input: ["Hello", "World"],
          encoding_format: "base64",
        },
      },
      mockResponse: {
        object: "list",
        data: [
          { object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 },
          { object: "embedding", embedding: [0.4, 0.5, 0.6], index: 1 },
        ],
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 2, total_tokens: 2 },
      },
    });
  });

  test("azure-openai requires env.deployment", () => {
    expect(() =>
      constructLlmApi({
        provider: "azure",
        apiKey: "test-api-key",
        apiBase: "https://test.openai.azure.com",
        env: {
          apiType: "azure-openai",
          apiVersion: API_VERSION,
        },
      }),
    ).toThrow(
      "`env.deployment` is a required configuration property for Azure OpenAI",
    );
  });

  test("azure-openai requires env.apiVersion", () => {
    expect(() =>
      constructLlmApi({
        provider: "azure",
        apiKey: "test-api-key",
        apiBase: "https://test.openai.azure.com",
        env: {
          apiType: "azure-openai",
          deployment: "gpt-4.1",
        },
      }),
    ).toThrow(
      "`env.apiVersion` is a required configuration property for Azure OpenAI",
    );
  });
});
