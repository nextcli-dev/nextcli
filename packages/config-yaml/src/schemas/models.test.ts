import { modelSchema } from "./models.js";

describe("modelSchema", () => {
  const model = { name: "Bridge", provider: "openai", model: "gpt-x" };

  // `transport` went with the AI-SDK transport; a config that still sets
  // it keeps loading, without it
  it("loads a model that still sets the removed transport", () => {
    const parsed = modelSchema.parse({ ...model, transport: "ai-sdk" });
    expect(parsed).toEqual(model);
  });
});
