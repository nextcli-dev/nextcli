import { describe, expect, it } from "vitest";

import { getModelControls, type ModelIdentity } from "../modelControls.js";

/**
 * What the model menus offer for popular models, from the models.dev
 * snapshot plus each API's rules. A catalog sync (npm run sync-models) that
 * changes what requests send shows up here as a snapshot diff, for review:
 * efforts, Off (the "off" thinking mode), fast mode and the largest context.
 * Update with `npx vitest run -u` once the change is checked.
 */
const MODELS: ModelIdentity[] = [
  { provider: "anthropic", model: "claude-opus-5-5" },
  { provider: "anthropic", model: "claude-sonnet-5-5" },
  { provider: "anthropic", model: "claude-haiku-5-5" },
  { provider: "anthropic", model: "claude-sonnet-4-5" },
  { provider: "anthropic", model: "claude-opus-4-8" },
  { provider: "openai", model: "gpt-5.5" },
  { provider: "openai", model: "gpt-5.4-mini" },
  { provider: "openai", model: "gpt-5-pro" },
  { provider: "openai", model: "gpt-6.1-terra" },
  { provider: "openai", model: "gpt-6-sol" },
  { provider: "openai", model: "gpt-4.1" },
  { provider: "openai", model: "gpt-4o-2024-08-06" },
  { provider: "openai", model: "o3" },
  { provider: "gemini", model: "gemini-3.5-flash" },
  { provider: "gemini", model: "gemini-3.1-pro" },
  { provider: "xAI", model: "grok-4.7" },
  { provider: "xAI", model: "grok-4.5" },
  { provider: "deepseek", model: "deepseek-v4-pro" },
  { provider: "deepseek", model: "deepseek-v4-flash" },
  { provider: "groq", model: "openai/gpt-oss-120b" },
  {
    provider: "openai",
    model: "llama-3.3-70b-versatile",
    apiBase: "https://api.groq.com/openai/v1",
  },
  { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" },
  { provider: "openrouter", model: "deepseek/deepseek-v4-pro" },
  { provider: "openrouter", model: "google/gemini-3.5-flash" },
  { provider: "oneprovider", model: "claude-opus-5-5" },
  { provider: "oneprovider", model: "claude-sonnet-5-5-thinking" },
  { provider: "oneprovider", model: "deepseek-v4-pro" },
  { provider: "oneprovider", model: "gpt-5.5" },
  { provider: "azure", model: "gpt-5.5" },
  { provider: "azure", model: "claude-fable-5" },
  { provider: "moonshot", model: "kimi-k3" },
  { provider: "mistral", model: "mistral-large" },
  { provider: "bedrock", model: "us.anthropic.claude-opus-5-5-v1:0" },
  {
    provider: "openai",
    model: "deepseek-v4-pro",
    apiBase: "http://127.0.0.1:8091/v1",
  },
];

describe("model controls of popular models", () => {
  it("match the reviewed snapshot", () => {
    const controls = Object.fromEntries(
      MODELS.map((identity) => {
        const c = getModelControls(identity);
        const key = identity.apiBase
          ? `${identity.provider} ${identity.model} @ ${identity.apiBase}`
          : `${identity.provider} ${identity.model}`;
        return [
          key,
          {
            efforts: c.efforts,
            thinkingModes: c.thinkingModes,
            fast: c.fast,
            maxContextLength: c.maxContextLength ?? null,
            experimental: c.experimental,
          },
        ];
      }),
    );
    expect(controls).toMatchSnapshot();
  });
});
