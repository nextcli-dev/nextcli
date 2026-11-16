import { describe, expect, it } from "vitest";
import type { LLMInteraction } from "../hooks/useLLMLog";
import { interactionCost } from "./interactionCost";

function interaction(
  start: Partial<NonNullable<LLMInteraction["start"]>>,
): LLMInteraction {
  return {
    start: {
      kind: "startChat",
      interactionId: "i",
      timestamp: 0,
      messages: [],
      provider: "openai",
      options: { model: "deepseek-v4-pro" },
      ...start,
    } as LLMInteraction["start"],
    results: [],
    end: {
      kind: "success",
      interactionId: "i",
      timestamp: 1,
      promptTokens: 1_000_000,
      generatedTokens: 1_000_000,
      thinkingTokens: 0,
      usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
    } as LLMInteraction["end"],
  };
}

describe("interactionCost", () => {
  // Prices themselves are tested in core (calculateRequestCost.vitest.ts)
  it("prices by the host the request went to", () => {
    const gpt = { options: { model: "gpt-4o" } };
    expect(interactionCost(interaction(gpt))?.priced).toBe("exact");
    expect(
      interactionCost(
        interaction({ ...gpt, apiBase: "https://openpaths.io/v1" }),
      )?.priced,
    ).toBe("estimated");
  });

  it("prices fast mode only when the request sent it", () => {
    const standard = interactionCost(
      interaction({ options: { model: "gpt-5.5" } }),
    )!.cost;
    // Core logs fast: false when the model has no fast mode to send
    expect(
      interactionCost(
        interaction({ options: { model: "gpt-5.5", fast: false } }),
      )?.cost,
    ).toBe(standard);
    expect(
      interactionCost(
        interaction({ options: { model: "gpt-5.5", fast: true } }),
      )!.cost,
    ).toBeGreaterThan(standard);
  });

  it("prices by the model's configured pricing, which the start carries", () => {
    const start = { pricing: { input: 0.5, output: 1.5 } };
    expect(interactionCost(interaction(start))).toMatchObject({
      cost: 2,
      priced: "exact",
    });
  });

  it("returns null without usage", () => {
    expect(interactionCost({ results: [] })).toBeNull();
  });
});
