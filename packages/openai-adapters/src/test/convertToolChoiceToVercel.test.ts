import { describe, expect, it } from "vitest";

import { convertToolChoiceToVercel } from "../convertToolChoiceToVercel.js";

describe("convertToolChoiceToVercel", () => {
  const named = { type: "function" as const, function: { name: "say_hello" } };

  it("converts named function choices", () => {
    expect(convertToolChoiceToVercel(named)).toEqual({
      type: "tool",
      toolName: "say_hello",
    });
  });

  it("passes string choices through", () => {
    expect(convertToolChoiceToVercel("required")).toBe("required");
    expect(convertToolChoiceToVercel("none")).toBe("none");
  });

  it("downgrades forced choices for Anthropic models that reject them", () => {
    const target = { provider: "anthropic", model: "claude-sonnet-5-5" };
    expect(convertToolChoiceToVercel("required", target)).toBe("auto");
    expect(convertToolChoiceToVercel(named, target)).toBe("auto");
    expect(convertToolChoiceToVercel("none", target)).toBe("none");
  });

  it("keeps forced choices for other providers and models", () => {
    expect(
      convertToolChoiceToVercel("required", {
        provider: "anthropic",
        model: "claude-haiku-5-5",
      }),
    ).toBe("required");
    expect(
      convertToolChoiceToVercel(named, {
        provider: "openai",
        model: "claude-sonnet-5-5",
      }),
    ).toEqual({ type: "tool", toolName: "say_hello" });
  });
});
