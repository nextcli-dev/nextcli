import { findCatalogCost, findGeneralCost } from "@nextcli/llm-info";
import { describe, expect, it } from "vitest";

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

  it("gives a local bridge the general price", () => {
    const general = findGeneralCost("deepseek-v4-pro")!;
    expect(
      priceRequest(
        {
          provider: "openai",
          model: "deepseek-v4-pro",
          apiBase: "http://127.0.0.1:8091/v1",
        },
        usage,
      ),
    ).toEqual({
      cost: expect.closeTo(general.input + general.output, 6),
      priced: "estimated",
    });
  });

  it("charges local model servers the flat fallback rate, never zero", () => {
    expect(
      priceRequest({ provider: "ollama", model: "deepseek-v4-pro" }, usage),
    ).toEqual({ cost: 3, priced: "fallback" });
  });
});
