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
});
