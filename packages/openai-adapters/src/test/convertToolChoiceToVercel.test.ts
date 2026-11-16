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
});
