import { describe, expect, test } from "vitest";

import Bedrock from "./Bedrock.js";

const llm = new Bedrock({
  model: "us.anthropic.claude-sonnet-4-6-v1:0",
  region: "us-east-1",
  accessKeyId: "test",
  secretAccessKey: "test",
} as any);

function convert(options: Record<string, unknown>) {
  return (llm as any)._generateConverseInput(
    [{ role: "user", content: "Hi" }],
    {
      model: "us.anthropic.claude-sonnet-4-6-v1:0",
      maxTokens: 8000,
      ...options,
    },
  );
}

describe("Bedrock Claude thinking settings", () => {
  test("drops temperature and a low top_p while thinking", () => {
    const input = convert({ thinking: "shown", temperature: 0.2, topP: 0.5 });
    expect(input.additionalModelRequestFields.thinking).toMatchObject({
      type: "adaptive",
    });
    expect(input.inferenceConfig.temperature).toBeUndefined();
    expect(input.inferenceConfig.topP).toBeUndefined();
  });

  test("keeps a top_p of 0.95 or more while thinking", () => {
    expect(
      convert({ thinking: "hidden", topP: 0.98 }).inferenceConfig.topP,
    ).toBe(0.98);
  });

  test("keeps sampling settings with thinking off", () => {
    const input = convert({ thinking: "off", temperature: 0.2 });
    expect(input.additionalModelRequestFields.thinking).toEqual({
      type: "disabled",
    });
    expect(input.inferenceConfig.temperature).toBe(0.2);
    expect(convert({ thinking: "off", topP: 0.5 }).inferenceConfig.topP).toBe(
      0.5,
    );
  });

  test("uses a configured budget when a thinking mode is on", () => {
    const sonnet45 = (options: Record<string, unknown>) =>
      (llm as any)._generateConverseInput([{ role: "user", content: "Hi" }], {
        model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        maxTokens: 16000,
        ...options,
      });
    expect(
      sonnet45({ thinking: "shown", reasoningBudgetTokens: 6000 })
        .additionalModelRequestFields.thinking,
    ).toEqual({ type: "enabled", budget_tokens: 6000 });
    expect(
      sonnet45({ thinking: "off", reasoningBudgetTokens: 6000 })
        .additionalModelRequestFields.thinking,
    ).toEqual({ type: "disabled" });
    // A budget alone doesn't turn thinking on
    expect(
      sonnet45({ reasoningBudgetTokens: 6000 }).additionalModelRequestFields
        .thinking,
    ).toBeUndefined();
  });
});
