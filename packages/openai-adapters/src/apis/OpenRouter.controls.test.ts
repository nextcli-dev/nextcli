import { describe, expect, it } from "vitest";

import { OpenRouterApi } from "./OpenRouter.js";

describe("OpenRouter model menu controls", () => {
  const api = new OpenRouterApi({ provider: "openrouter", apiKey: "sk-or-x" });

  it("maps effort and hidden thinking to OpenRouter fields", () => {
    const body = api.modifyChatBody({
      model: "openai/gpt-5.5",
      messages: [{ role: "user", content: "Hi" }],
      reasoning_effort: "high",
      nextcli_show_thinking: false,
      nextcli_fast: true,
    } as any) as any;

    expect(body.reasoning).toEqual({ effort: "high", exclude: true });
    // Throughput routing isn't a fast mode, so it's never requested
    expect(body).not.toHaveProperty("provider");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("nextcli_fast");
    expect(body).not.toHaveProperty("nextcli_show_thinking");
  });

  it("leaves the body alone without controls", () => {
    const body = api.modifyChatBody({
      model: "openai/gpt-5.5",
      messages: [{ role: "user", content: "Hi" }],
    }) as any;
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("provider");
  });
});

describe("OpenRouter thinking off", () => {
  const api = new OpenRouterApi({ provider: "openrouter", apiKey: "sk-or-x" });

  it("disables reasoning and drops the effort", () => {
    const body = api.modifyChatBody({
      model: "qwen/qwen3-max",
      messages: [{ role: "user", content: "Hi" }],
      reasoning_effort: "high",
      nextcli_thinking: "off",
      nextcli_show_thinking: false,
    } as any) as any;

    expect(body.reasoning).toEqual({ enabled: false });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("nextcli_thinking");
  });
});

describe("OpenRouter thinking shown", () => {
  const api = new OpenRouterApi({ provider: "openrouter", apiKey: "sk-or-x" });

  it("asks for reasoning when Shown is chosen without an effort", () => {
    const body = api.modifyChatBody({
      model: "anthropic/claude-haiku-5.5",
      messages: [{ role: "user", content: "Hi" }],
      nextcli_thinking: "shown",
      nextcli_show_thinking: true,
    } as any) as any;
    expect(body.reasoning).toEqual({ enabled: true });
  });

  it("keeps the effort when one is set", () => {
    const body = api.modifyChatBody({
      model: "anthropic/claude-haiku-5.5",
      messages: [{ role: "user", content: "Hi" }],
      reasoning_effort: "low",
      nextcli_thinking: "shown",
    } as any) as any;
    expect(body.reasoning).toEqual({ effort: "low" });
  });
});
