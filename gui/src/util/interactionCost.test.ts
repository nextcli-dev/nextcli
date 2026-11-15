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
  it("prices by the host the request went to, as the CLI does", () => {
    // An openai provider pointed at OneProvider: OneProvider's own price
    const cost = interactionCost(
      interaction({ apiBase: "https://api.oneprovider.dev/v1" }),
    );
    expect(cost?.cost).toBeCloseTo(1.32 + 3.96, 6);
    expect(cost?.priced).toBe("exact");
  });

  it("marks a GPT model on a gateway estimated", () => {
    expect(
      interactionCost(
        interaction({
          options: { model: "gpt-4o" },
          apiBase: "https://openpaths.io/v1",
        }),
      )?.priced,
    ).toBe("estimated");
  });

  it("gives no cost for a bridge on a local host", () => {
    expect(
      interactionCost(interaction({ apiBase: "http://127.0.0.1:8091/v1" })),
    ).toBeNull();
  });

  it("returns null without usage", () => {
    expect(interactionCost({ results: [] })).toBeNull();
  });
});
