import { AssistantUnrolled, ModelConfig } from "@nextcli/config-yaml";
import { describe, expect, test, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("./auth/workos.js");
vi.mock("./util/logger.js", () => ({ logger: { debug: vi.fn() } }));

import { AiSdkApi } from "@nextcli/openai-adapters";

import type { AuthConfig } from "./auth/workos.js";
import { createLlmApi, getLlmApi, withCliAttribution } from "./config.js";
import { logger } from "./util/logger.js";

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
    const bridge = {
      provider: "openai",
      model: "deepseek-v4-pro",
      name: "Bridge",
      apiBase: "http://127.0.0.1:8091/v1",
      transport: "ai-sdk",
    } as ModelConfig;

    test("says which transport the chat model uses when the AI SDK is chosen", () => {
      expect(createLlmApi(bridge, mockAuthConfig)).toBeInstanceOf(AiSdkApi);
      expect(logger.debug).toHaveBeenCalledWith("Chat transport", {
        model: "deepseek-v4-pro",
        transport: "ai-sdk",
      });

      createLlmApi(
        {
          ...bridge,
          provider: "oneprovider",
          model: "claude-sonnet-5-5",
          apiBase: undefined,
        } as ModelConfig,
        mockAuthConfig,
      );
      expect(logger.debug).toHaveBeenLastCalledWith("Chat transport", {
        model: "claude-sonnet-5-5",
        transport: "oneprovider's own adapter (no AI-SDK route for this model)",
      });
    });

    test("says nothing when the provider's own adapter is chosen", () => {
      createLlmApi(
        { ...bridge, transport: undefined } as ModelConfig,
        mockAuthConfig,
      );
      expect(logger.debug).not.toHaveBeenCalled();
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
