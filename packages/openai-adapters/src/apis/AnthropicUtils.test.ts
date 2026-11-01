import { vi } from "vitest";
import {
  anthropicSupportsForcedToolChoice,
  anthropicThinkingType,
  filterAnthropicSamplingParams,
  getAnthropicHeaders,
  isAzureAnthropicEndpoint,
  openAiToolChoiceToAnthropicToolChoice,
  parseClaudeModelVersion,
} from "./AnthropicUtils.js";

describe("isAzureAnthropicEndpoint", () => {
  describe("should return true for Azure endpoints", () => {
    it("detects Azure AI Foundry endpoint", () => {
      expect(
        isAzureAnthropicEndpoint(
          "https://my-resource.services.ai.azure.com/anthropic",
        ),
      ).toBe(true);
    });

    it("detects Azure Cognitive Services endpoint", () => {
      expect(
        isAzureAnthropicEndpoint(
          "https://my-resource.cognitiveservices.azure.com/anthropic",
        ),
      ).toBe(true);
    });

    it("handles case insensitivity", () => {
      expect(
        isAzureAnthropicEndpoint(
          "https://my-resource.SERVICES.AI.AZURE.COM/anthropic",
        ),
      ).toBe(true);
    });

    it("handles mixed case", () => {
      expect(
        isAzureAnthropicEndpoint(
          "https://My-Resource.Services.AI.Azure.Com/anthropic/v1/messages",
        ),
      ).toBe(true);
    });
  });

  describe("should return false for non-Azure endpoints", () => {
    it("returns false for standard Anthropic endpoint", () => {
      expect(isAzureAnthropicEndpoint("https://api.anthropic.com")).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isAzureAnthropicEndpoint(undefined)).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isAzureAnthropicEndpoint("")).toBe(false);
    });

    it("returns false for invalid URL", () => {
      expect(isAzureAnthropicEndpoint("not-a-valid-url")).toBe(false);
    });

    it("returns false for other providers", () => {
      expect(isAzureAnthropicEndpoint("https://api.openai.com/v1")).toBe(false);
    });
  });

  describe("URL parsing security", () => {
    it("rejects Azure pattern in path (not hostname)", () => {
      // This should NOT match - Azure domain is in path, not hostname
      expect(
        isAzureAnthropicEndpoint(
          "https://evil.com/services.ai.azure.com/anthropic",
        ),
      ).toBe(false);
    });

    it("rejects Azure pattern as subdomain of non-Azure domain", () => {
      expect(
        isAzureAnthropicEndpoint(
          "https://services.ai.azure.com.evil.com/anthropic",
        ),
      ).toBe(false);
    });
  });
});

describe("getAnthropicHeaders", () => {
  describe("authentication header", () => {
    it("uses x-api-key for standard Anthropic endpoint", () => {
      const headers = getAnthropicHeaders(
        "test-key",
        false,
        "https://api.anthropic.com",
      );
      expect(headers["x-api-key"]).toBe("test-key");
      expect(headers["api-key"]).toBeUndefined();
    });

    it("uses x-api-key for Azure AI Foundry endpoint", () => {
      const headers = getAnthropicHeaders(
        "azure-key",
        false,
        "https://my-resource.services.ai.azure.com/anthropic",
      );
      expect(headers["x-api-key"]).toBe("azure-key");
      expect(headers["api-key"]).toBeUndefined();
    });

    it("uses api-key for Azure Cognitive Services endpoint", () => {
      const headers = getAnthropicHeaders(
        "azure-key",
        false,
        "https://my-resource.cognitiveservices.azure.com/anthropic",
      );
      expect(headers["api-key"]).toBe("azure-key");
      expect(headers["x-api-key"]).toBeUndefined();
    });

    it("uses x-api-key when apiBase is undefined", () => {
      const headers = getAnthropicHeaders("test-key", false, undefined);
      expect(headers["x-api-key"]).toBe("test-key");
      expect(headers["api-key"]).toBeUndefined();
    });
  });

  describe("caching headers", () => {
    it("includes anthropic-beta header when caching is enabled", () => {
      const headers = getAnthropicHeaders("test-key", true);
      expect(headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    });

    it("does not include anthropic-beta header when caching is disabled", () => {
      const headers = getAnthropicHeaders("test-key", false);
      expect(headers["anthropic-beta"]).toBeUndefined();
    });

    it("includes caching header for Azure endpoints too", () => {
      const headers = getAnthropicHeaders(
        "azure-key",
        true,
        "https://my-resource.services.ai.azure.com/anthropic",
      );
      expect(headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    });
  });

  describe("standard headers", () => {
    it("always includes anthropic-version header", () => {
      const headers = getAnthropicHeaders("test-key", false);
      expect(headers["anthropic-version"]).toBe("2023-06-01");
    });

    it("always includes Content-Type and Accept headers", () => {
      const headers = getAnthropicHeaders("test-key", false);
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["Accept"]).toBe("application/json");
    });
  });

  describe("key/endpoint mismatch warning", () => {
    it("warns when Azure endpoint is used with Anthropic-style key", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      getAnthropicHeaders(
        "sk-ant-test-key",
        false,
        "https://my-resource.services.ai.azure.com/anthropic",
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Azure endpoint detected"),
      );
      warnSpy.mockRestore();
    });

    it("does not warn when Azure endpoint is used with Azure key", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      getAnthropicHeaders(
        "azure-api-key-12345",
        false,
        "https://my-resource.services.ai.azure.com/anthropic",
      );
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("does not warn when standard Anthropic endpoint is used with Anthropic key", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      getAnthropicHeaders(
        "sk-ant-test-key",
        false,
        "https://api.anthropic.com",
      );
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});

// Expected values come from probing the live API on 2026-11-01
describe("parseClaudeModelVersion", () => {
  it.each([
    ["claude-sonnet-5-5", { family: "sonnet", major: 5, minor: 5 }],
    ["claude-opus-5", { family: "opus", major: 5, minor: 0 }],
    ["claude-opus-4-5-20251101", { family: "opus", major: 4, minor: 5 }],
    ["claude-sonnet-4-20250514", { family: "sonnet", major: 4, minor: 0 }],
    ["claude-3-5-sonnet-20241022", { family: "sonnet", major: 3, minor: 5 }],
    ["claude-3-7-sonnet-latest", { family: "sonnet", major: 3, minor: 7 }],
    [
      "us.anthropic.claude-opus-4-7-v1:0",
      { family: "opus", major: 4, minor: 7 },
    ],
    ["anthropic/claude-fable-5-1", { family: "fable", major: 5, minor: 1 }],
  ])("parses %s", (model, expected) => {
    expect(parseClaudeModelVersion(model)).toEqual(expected);
  });

  it("returns undefined for non-Claude models", () => {
    expect(parseClaudeModelVersion("gpt-5.5")).toBeUndefined();
    expect(parseClaudeModelVersion(undefined)).toBeUndefined();
  });
});

describe("anthropicThinkingType", () => {
  it.each([
    ["claude-haiku-4-5-20251001", "enabled"],
    ["claude-opus-4-5-20251101", "enabled"],
    ["claude-3-7-sonnet-latest", "enabled"],
    ["claude-sonnet-4-6", "adaptive"],
    ["claude-opus-4-7", "adaptive"],
    ["claude-opus-5", "adaptive"],
    ["claude-haiku-5-5", "adaptive"],
    ["claude-sonnet-5-5", "adaptive"],
    ["claude-fable-5-1", "adaptive"],
    ["some-proxy-model", "enabled"],
  ])("%s uses %s thinking", (model, expected) => {
    expect(anthropicThinkingType(model)).toBe(expected);
  });
});

describe("anthropicSupportsForcedToolChoice", () => {
  it.each([
    ["claude-haiku-5-5", true],
    ["claude-opus-5", true],
    ["claude-sonnet-5", true],
    ["claude-fable-5", true],
    ["claude-opus-4-8", true],
    ["claude-sonnet-4-6", true],
    ["claude-sonnet-5-5", false],
    ["claude-opus-5-5", false],
    ["claude-fable-5-1", false],
    ["some-proxy-model", true],
  ])("%s supports forced tool_choice: %s", (model, expected) => {
    expect(anthropicSupportsForcedToolChoice(model)).toBe(expected);
  });
});

describe("openAiToolChoiceToAnthropicToolChoice", () => {
  const named = {
    type: "function" as const,
    function: { name: "say_hello" },
  };

  it("keeps forced choices for models that accept them", () => {
    expect(
      openAiToolChoiceToAnthropicToolChoice("required", "claude-haiku-5-5"),
    ).toEqual({ type: "any" });
    expect(
      openAiToolChoiceToAnthropicToolChoice(named, "claude-haiku-5-5"),
    ).toEqual({ type: "tool", name: "say_hello" });
  });

  it("downgrades forced choices to auto for models that reject them", () => {
    expect(
      openAiToolChoiceToAnthropicToolChoice("required", "claude-sonnet-5-5"),
    ).toEqual({ type: "auto" });
    expect(
      openAiToolChoiceToAnthropicToolChoice(named, "claude-opus-5-5"),
    ).toEqual({ type: "auto" });
  });

  it("leaves auto and none unchanged", () => {
    expect(
      openAiToolChoiceToAnthropicToolChoice("auto", "claude-sonnet-5-5"),
    ).toEqual({ type: "auto" });
    expect(
      openAiToolChoiceToAnthropicToolChoice("none", "claude-sonnet-5-5"),
    ).toBeUndefined();
  });
});

describe("filterAnthropicSamplingParams", () => {
  const all = { temperature: 0.5, topP: 0.9, topK: 40 };

  it("drops all sampling params for Opus 4.7 and newer", () => {
    for (const model of [
      "claude-opus-4-7",
      "claude-sonnet-5",
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "us.anthropic.claude-opus-4-8-v1:0",
    ]) {
      expect(filterAnthropicSamplingParams(model, all)).toEqual({});
    }
  });

  it("drops top_p when temperature is also set on older models", () => {
    expect(filterAnthropicSamplingParams("claude-sonnet-4-6", all)).toEqual({
      temperature: 0.5,
      topK: 40,
    });
  });

  it("keeps a single sampling param on older models", () => {
    expect(
      filterAnthropicSamplingParams("claude-haiku-4-5-20251001", { topP: 0.9 }),
    ).toEqual({ topP: 0.9 });
  });

  it("passes non-Claude models through", () => {
    expect(filterAnthropicSamplingParams("meta.llama3-70b", all)).toEqual(all);
  });
});
