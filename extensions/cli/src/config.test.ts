import { AssistantUnrolled, ModelConfig } from "@nextcli/config-yaml";
import type { ChatCompletionCreateParams } from "openai/resources/index";
import { describe, expect, test, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("./auth/workos.js");

import type { AuthConfig } from "./auth/workos.js";
import { createLlmApi, getLlmApi, withCliAttribution } from "./config.js";

describe("config", () => {
  let mockAuthConfig: AuthConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    mockAuthConfig = null;
  });

  describe("getLlmApi()", () => {
    test("should throw error when models array is empty", () => {
      const assistant: AssistantUnrolled = {
        name: "test-assistant",
        version: "1.0.0",
        models: [],
      };

      expect(() => getLlmApi(assistant, mockAuthConfig)).toThrow(
        "No models found in the configured assistant",
      );
    });

    test("should throw error when no chat models available", () => {
      const assistant: AssistantUnrolled = {
        name: "test-assistant",
        version: "1.0.0",
        models: [
          {
            provider: "openai",
            model: "text-embedding-ada-002",
            name: "Ada Embeddings",
            roles: ["embed"],
          } as ModelConfig,
        ],
      };

      expect(() => getLlmApi(assistant, mockAuthConfig)).toThrow(
        "No models with the chat role found in the configured assistant",
      );
    });
  });

  describe("createLlmApi()", () => {
    test("names the config that replaces the removed ai-sdk provider", () => {
      const old = {
        provider: "ai-sdk",
        model: "openai/gpt-4o",
        name: "Old",
      } as ModelConfig;
      expect(() => createLlmApi(old, mockAuthConfig)).toThrow(
        'provider "ai-sdk" was removed; use provider "openai" with model "gpt-4o"',
      );
    });

    test("builds the provider's adapter for a bridge", () => {
      const bridge = {
        provider: "openai",
        model: "deepseek-v4-pro",
        name: "Bridge",
        apiBase: "http://127.0.0.1:8091/v1",
      } as ModelConfig;
      expect(createLlmApi(bridge, mockAuthConfig)).not.toBeNull();
    });

    describe("Claude prompt caching", () => {
      const claude = {
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        name: "Claude",
        apiKey: "k",
      } as ModelConfig;
      const body = (model: ModelConfig) =>
        JSON.stringify(
          (
            createLlmApi(model, mockAuthConfig) as unknown as {
              _convertBody(body: ChatCompletionCreateParams): unknown;
            }
          )._convertBody({
            model: "claude-sonnet-5-5",
            messages: [
              { role: "system", content: "You are a coding agent." },
              { role: "user", content: "Fix the test." },
            ],
          }),
        );

      test("is on by default", () => {
        expect(body(claude)).toContain('"cache_control"');
      });

      test("is off when the model sets promptCaching: false", () => {
        expect(
          body({
            ...claude,
            defaultCompletionOptions: { promptCaching: false },
          }),
        ).not.toContain('"cache_control"');
      });
    });
  });

  describe("withCliAttribution()", () => {
    const openrouter = {
      name: "OR",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5-5",
    } as ModelConfig;

    test("marks OpenRouter requests as coming from a CLI agent", () => {
      expect(withCliAttribution(openrouter)?.headers).toEqual({
        "X-OpenRouter-Categories": "cli-agent",
      });
    });

    test("keeps the model's own headers and lets them win", () => {
      const options = withCliAttribution({
        ...openrouter,
        requestOptions: {
          timeout: 5,
          headers: { "X-OpenRouter-Categories": "programming-app", a: "b" },
        },
      });
      expect(options).toEqual({
        timeout: 5,
        headers: { "X-OpenRouter-Categories": "programming-app", a: "b" },
      });
    });

    test("leaves other providers untouched", () => {
      const model = {
        name: "OAI",
        provider: "openai",
        model: "gpt-5",
        requestOptions: { headers: { a: "b" } },
      } as ModelConfig;
      expect(withCliAttribution(model)).toBe(model.requestOptions);
    });
  });
});
