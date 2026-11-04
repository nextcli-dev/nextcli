import { jest } from "@jest/globals";
import Anthropic from "../Anthropic.js";
import Deepseek from "../Deepseek.js";
import FunctionNetwork from "../FunctionNetwork.js";
import Mistral from "../Mistral.js";
import OpenAI from "../OpenAI.js";
import Vllm from "../Vllm.js";

// Test cases: [LLM class, model, expected supportsFim result, description]
const testCases: [any, string, boolean, string, string?][] = [
  [Vllm, "any-model", false, "Vllm"],
  [Anthropic, "claude-sonnet-5-5", false, "Anthropic"],
  [FunctionNetwork, "any-model", false, "FunctionNetwork"],
  [OpenAI, "codestral", false, "OpenAI"],
  [Mistral, "codestral-latest", true, "Mistral"],
  [
    Mistral,
    "mistral-small-latest",
    false,
    "Mistral behind a gateway",
    "https://gateway.example.com/v1/",
  ],
  [Deepseek, "deepseek-v4-pro", true, "Deepseek"],
  // OneProvider has no beta/completions route (404 not_found_error)
  [
    Deepseek,
    "deepseek-v4-pro",
    false,
    "Deepseek through OneProvider",
    "https://api.oneprovider.dev",
  ],
];

testCases.forEach(([LLMClass, model, expectedResult, description, apiBase]) => {
  test(`supportsFim returns ${expectedResult} for ${description}`, () => {
    const llm = new LLMClass({
      model,
      apiKey: "test-key",
      ...(apiBase ? { apiBase } : {}),
    });

    const result = llm.supportsFim();

    expect(result).toBe(expectedResult);
  });
});
