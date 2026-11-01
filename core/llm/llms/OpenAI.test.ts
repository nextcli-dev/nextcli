import OpenAI from "./OpenAI";

describe("OpenAI", () => {
  test("should identify correct o-series models", () => {
    const openai = new OpenAI({
      model: "o3-mini",
    });
    expect(openai.isOSeriesOrGpt5PlusModel("o4-mini")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("o3-mini")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("o1-mini")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("o1")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("o3")).toBeTruthy();

    // artificially correct samples for future models
    expect(openai.isOSeriesOrGpt5PlusModel("o5-mini")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("o6")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("o77")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("o54-mini")).toBeTruthy();

    // gpt-5+ models
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-5")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-5.4")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-5.4-mini")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-5.4-pro")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-5.5")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-5.6-sol")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-6")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-6.1-sol")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-7-turbo")).toBeTruthy();
  });
  test("should identify incorrect o-series models", () => {
    const openai = new OpenAI({
      model: "o3-mini",
    });
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-o4-mini")).toBeFalsy();
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-4.5")).toBeFalsy();
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-4.1")).toBeFalsy();

    // artificially wrong samples
    expect(openai.isOSeriesOrGpt5PlusModel("os1")).toBeFalsy();
    expect(openai.isOSeriesOrGpt5PlusModel("so1")).toBeFalsy();
    expect(openai.isOSeriesOrGpt5PlusModel("ao31")).toBeFalsy();
    expect(openai.isOSeriesOrGpt5PlusModel("1os")).toBeFalsy();
  });

  test("drops temperature and top_p for reasoning models", () => {
    const openai = new OpenAI({ model: "gpt-5.5", apiKey: "test" });
    const body = (model: string) => ({
      model,
      messages: [{ role: "user" as const, content: "Hi" }],
      temperature: 0.5,
      top_p: 0.9,
    });
    for (const model of ["gpt-5.5", "gpt-6-sol", "o3"]) {
      const result = (openai as any).modifyChatBody(body(model));
      expect(result.temperature).toBeUndefined();
      expect(result.top_p).toBeUndefined();
    }
    const kept = (openai as any).modifyChatBody(body("gpt-4o"));
    expect(kept.temperature).toBe(0.5);
    expect(kept.top_p).toBe(0.9);
  });

  test("sends null temperature and top_p to the Responses API for reasoning models", () => {
    const openai = new OpenAI({ model: "gpt-6-sol", apiKey: "test" });
    const args = (openai as any)._convertArgsResponses(
      { model: "gpt-6-sol", temperature: 0.5, topP: 0.9 },
      [{ role: "user", content: "Hi" }],
    );
    expect(args.temperature).toBeNull();
    expect(args.top_p).toBeNull();
  });
});
