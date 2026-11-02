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
