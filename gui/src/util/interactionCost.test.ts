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

  it("prices a known model behind a local bridge as an estimate", () => {
    // The bridge's upstream isn't visible: its vendor's list price is a floor
    expect(
      interactionCost(interaction({ apiBase: "http://127.0.0.1:8091/v1" }))
        ?.priced,
    ).toBe("estimated");
    expect(
      interactionCost(
        interaction({
          options: { model: "my-private-model" },
          apiBase: "http://127.0.0.1:8091/v1",
        }),
      ),
    ).toBeNull();
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

  it("returns null without usage", () => {
    expect(interactionCost({ results: [] })).toBeNull();
  });
});
