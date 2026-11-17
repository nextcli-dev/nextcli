import { modelSchema } from "./models.js";

describe("modelSchema", () => {
  const model = { name: "Bridge", provider: "openai", model: "gpt-x" };

  // `transport` went with the AI-SDK transport; a config that still sets
  // it keeps loading, without it
  it("loads a model that still sets the removed transport", () => {
    const parsed = modelSchema.parse({ ...model, transport: "ai-sdk" });
    expect(parsed).toEqual(model);
  });

  it("takes the model's prices, and refuses a negative one", () => {
    const pricing = { input: 0.5, output: 1.5, cacheRead: 0.05 };
    expect(modelSchema.parse({ ...model, pricing }).pricing).toEqual(pricing);
    expect(
      modelSchema.safeParse({ ...model, pricing: { input: -1, output: 1 } })
        .success,
    ).toBe(false);
    expect(
      modelSchema.safeParse({ ...model, pricing: { input: 1 } }).success,
    ).toBe(false);
  });
});
