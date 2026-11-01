import { ChatCompletionCreateParams } from "openai/resources/index";
import { describe, expect, it } from "vitest";

import { OpenAIApi } from "./OpenAI.js";
import { toResponsesParams } from "./openaiResponses.js";

// Behavior checked against the live OpenAI API on 2026-11-01
describe("OpenAI reasoning model request bodies", () => {
  const api = new OpenAIApi({ provider: "openai", apiKey: "test-key" });
  const body = (model: string): ChatCompletionCreateParams => ({
    model,
    messages: [{ role: "user", content: "Hi" }],
    temperature: 0.5,
    top_p: 0.9,
  });

  it("drops temperature and top_p for reasoning models on Chat Completions", () => {
    for (const model of ["gpt-5.5", "gpt-6-sol", "o3"]) {
      const result = api.modifyChatBody(body(model));
      expect(result.temperature).toBeUndefined();
      expect(result.top_p).toBeUndefined();
    }
  });

  it("keeps temperature and top_p for other models", () => {
    const result = api.modifyChatBody(body("gpt-4o"));
    expect(result.temperature).toBe(0.5);
    expect(result.top_p).toBe(0.9);
  });

  it("drops temperature and top_p for reasoning models on the Responses API", () => {
    const params = toResponsesParams(body("gpt-6-sol"));
    expect(params.temperature).toBeUndefined();
    expect(params.top_p).toBeUndefined();
  });

  it("converts a named tool_choice to the Responses API shape", () => {
    const params = toResponsesParams({
      ...body("gpt-5.5"),
      tool_choice: { type: "function", function: { name: "say_hello" } },
    });
    expect(params.tool_choice).toEqual({ type: "function", name: "say_hello" });
  });

  it("passes string tool_choice values through", () => {
    expect(
      toResponsesParams({ ...body("gpt-5.5"), tool_choice: "required" })
        .tool_choice,
    ).toBe("required");
  });

  it("drops sampling params Claude 4.7+ rejects when served through an OpenAI-compatible gateway", () => {
    const gateway = new OpenAIApi({
      provider: "openai",
      apiKey: "test-key",
      apiBase: "https://gateway.example/v1",
    });
    const result = gateway.modifyChatBody(body("claude-sonnet-5-5"));
    expect(result.temperature).toBeUndefined();
    expect(result.top_p).toBeUndefined();

    // Older Claude models only reject temperature and top_p together
    const older = gateway.modifyChatBody(body("claude-sonnet-4-6"));
    expect(older.temperature).toBe(0.5);
    expect(older.top_p).toBeUndefined();
  });
});
