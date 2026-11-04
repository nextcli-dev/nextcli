import { describe, expect, it } from "vitest";

import { supportsFimEndpoint } from "./fimEndpoints.js";

describe("supportsFimEndpoint", () => {
  it.each([
    ["deepseek", undefined, true],
    ["deepseek", "https://api.deepseek.com/", true],
    ["deepseek", "https://api.deepseek.com/beta", true],
    // Gateways and bridges have no FIM route (OneProvider answers 404)
    ["deepseek", "https://api.oneprovider.dev", false],
    ["deepseek", "https://api.oneprovider.dev/v1", false],
    ["deepseek", "https://openrouter.ai/api/v1/", false],
    ["deepseek", "http://127.0.0.1:8091/v1", false],
    ["mistral", undefined, true],
    ["mistral", "https://api.mistral.ai/v1/", true],
    ["mistral", "https://codestral.mistral.ai/v1/", true],
    ["mistral", "https://my-gateway.example.com/v1/", false],
    // OpenAI has no FIM endpoint at all
    ["openai", undefined, false],
    ["openai", "https://api.openai.com/v1/", false],
    ["deepseek", "not a url", false],
  ])("%s at %s → %s", (provider, apiBase, expected) => {
    expect(supportsFimEndpoint(provider, apiBase)).toBe(expected);
  });
});
