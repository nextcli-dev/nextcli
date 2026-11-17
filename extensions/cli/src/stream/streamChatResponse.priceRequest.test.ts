import { describe, expect, it, vi } from "vitest";

const fast = vi.hoisted(() => ({ on: false }));
vi.mock("../util/modelSettings.js", () => ({
  fastModeOn: () => fast.on,
}));

import { priceRequest } from "./streamChatResponse.helpers.js";

// Prices themselves are tested in core (calculateRequestCost.vitest.ts);
// streamChatResponse.finalAnswer.test.ts covers hosts and the fallback rate
describe("priceRequest", () => {
  it("prices a run with fast mode on at the fast price, with the catalog date", () => {
    const model = { provider: "openai", model: "gpt-5.5" };
    const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000 };
    const standard = priceRequest(model, usage);
    fast.on = true;
    try {
      const priority = priceRequest(model, usage);
      expect(priority.cost).toBeGreaterThan(standard.cost);
      expect(priority.priced).toBe("exact");
      expect(priority.catalogDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } finally {
      fast.on = false;
    }
  });

  it("prices a model with configured pricing exactly, at its rates", () => {
    // A model nothing else prices: the flat fallback rate without pricing
    const model = {
      provider: "openai",
      model: "my-finetune",
      apiBase: "https://llm.example.com/v1",
    };
    const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000 };
    expect(priceRequest(model, usage).priced).toBe("fallback");

    const priced = priceRequest(
      { ...model, pricing: { input: 0.5, output: 1.5 } },
      usage,
    );
    expect(priced).toEqual({ cost: 2, priced: "exact" });
  });
});
