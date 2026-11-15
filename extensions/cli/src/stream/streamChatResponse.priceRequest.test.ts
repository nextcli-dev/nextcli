import {
  CATALOG_SYNCED_AT,
  findCatalogCost,
  findCatalogFastCost,
  findGeneralCost,
} from "@nextcli/llm-info";
import { describe, expect, it, vi } from "vitest";

const fast = vi.hoisted(() => ({ on: false }));
vi.mock("../util/modelSettings.js", () => ({
  fastModeOn: () => fast.on,
}));

import { priceRequest } from "./streamChatResponse.helpers.js";

const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000 };

describe("priceRequest", () => {
  it("prices a provider's model from its own catalog entry", () => {
    // Before, DeepSeek was looked up as an Anthropic model and fell through
    const deepseek = findCatalogCost("deepseek", "deepseek-v4-pro")!;
    expect(
      priceRequest({ provider: "deepseek", model: "deepseek-v4-pro" }, usage),
    ).toEqual({
      cost: expect.closeTo(deepseek.input + deepseek.output, 6),
      priced: "catalog",
      catalogDate: CATALOG_SYNCED_AT,
    });
  });

  it("prices provider oneprovider from its own table", () => {
    expect(
      priceRequest(
        { provider: "oneprovider", model: "deepseek-v4-pro" },
        usage,
      ),
    ).toEqual({ cost: expect.closeTo(1.32 + 3.96, 6), priced: "exact" });
  });

  it("gives a custom gateway the general price", () => {
    const general = findGeneralCost("deepseek-v4-pro")!;
    expect(
      priceRequest(
        {
          provider: "openai",
          model: "deepseek-v4-pro",
          apiBase: "https://openpaths.io/v1",
        },
        usage,
      ),
    ).toEqual({
      cost: expect.closeTo(general.input + general.output, 6),
      priced: "estimated",
      catalogDate: CATALOG_SYNCED_AT,
    });
  });

  it("prices a known model behind a local bridge at its vendor's price", () => {
    // The bridge's upstream isn't visible: a known name sets a floor
    const deepseek = findCatalogCost("deepseek", "deepseek-v4-pro")!;
    const bridge = { provider: "openai", apiBase: "http://127.0.0.1:8091/v1" };
    expect(
      priceRequest({ ...bridge, model: "deepseek-v4-pro" }, usage),
    ).toMatchObject({
      cost: expect.closeTo(deepseek.input + deepseek.output, 6),
      priced: "estimated",
    });
    // An unknown name: the flat fallback rate, never zero
    expect(
      priceRequest({ ...bridge, model: "my-private-model" }, usage),
    ).toEqual({ cost: 3, priced: "fallback" });
  });

  it("bills a fast run at the fast price", () => {
    fast.on = true;
    try {
      const priority = findCatalogFastCost("openai", "gpt-5.5")!;
      expect(
        priceRequest({ provider: "openai", model: "gpt-5.5" }, usage),
      ).toEqual({
        cost: expect.closeTo(priority.input + priority.output, 6),
        // OpenAI's own price on OpenAI's API
        priced: "exact",
        catalogDate: CATALOG_SYNCED_AT,
      });
    } finally {
      fast.on = false;
    }
  });

  it("marks a GPT model on a gateway estimated, not exact", () => {
    expect(
      priceRequest(
        {
          provider: "openai",
          model: "gpt-4o",
          apiBase: "https://openpaths.io/v1",
        },
        usage,
      ).priced,
    ).toBe("estimated");
  });

  it("charges local model servers the flat fallback rate, never zero", () => {
    expect(
      priceRequest({ provider: "ollama", model: "deepseek-v4-pro" }, usage),
    ).toEqual({ cost: 3, priced: "fallback" });
  });
});
