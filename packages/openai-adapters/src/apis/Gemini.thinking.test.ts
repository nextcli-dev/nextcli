import { describe, expect, it } from "vitest";

import { GeminiApi, geminiThinkingConfig } from "./Gemini.js";

describe("geminiThinkingConfig", () => {
  it("turns thinking off with a budget of 0", () => {
    expect(geminiThinkingConfig("gemini-3.8-flash", "high", "off")).toEqual({
      thinkingBudget: 0,
    });
  });

  it("uses a thinking level on Gemini 3 and newer", () => {
    expect(geminiThinkingConfig("gemini-3.1-pro", "low", "shown")).toEqual({
      includeThoughts: true,
      thinkingLevel: "low",
    });
    expect(geminiThinkingConfig("gemini-3.1-pro", undefined, "hidden")).toEqual(
      { includeThoughts: false },
    );
  });

  it("maps the effort to a budget on Gemini 2.5", () => {
    expect(
      geminiThinkingConfig("gemini-2.5-flash", "medium", undefined),
    ).toEqual({ thinkingBudget: 8192 });
  });

  it("leaves the request alone without settings", () => {
    expect(geminiThinkingConfig("gemini-3.1-pro", undefined, undefined)).toBe(
      undefined,
    );
  });
});

describe("GeminiApi thinking settings", () => {
  const api = new GeminiApi({ provider: "gemini", apiKey: "test-key" });

  it("adds thinkingConfig to generationConfig", () => {
    const body = api._convertBody(
      {
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "low",
        nextcli_thinking: "shown",
      } as any,
      false,
      true,
    );
    expect(body.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "low",
    });
  });

  it("streams thought parts as reasoning", async () => {
    async function* response() {
      yield {
        candidates: [
          {
            content: {
              parts: [
                { text: "Let me check", thought: true },
                { text: "Done." },
              ],
            },
          },
        ],
      };
    }
    const deltas: any[] = [];
    for await (const chunk of (api as any).processStreamResponse(
      response(),
      "gemini-3.8-flash",
    )) {
      if (chunk.choices[0]?.delta) deltas.push(chunk.choices[0].delta);
    }
    expect(deltas[0]).toMatchObject({ reasoning: "Let me check" });
    expect(deltas[1]).toMatchObject({ content: "Done." });
    expect(deltas[1]).not.toHaveProperty("reasoning");
  });
});
