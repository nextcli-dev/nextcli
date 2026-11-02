import type { ChatHistoryItem, Reasoning } from "core/index.js";
import { convertFromUnifiedHistory } from "core/util/messageConversion.js";
import { describe, expect, it } from "vitest";

function user(content: string): ChatHistoryItem {
  return { message: { role: "user", content }, contextItems: [] };
}

function assistant(content: string, reasoning?: Reasoning): ChatHistoryItem {
  return {
    message: { role: "assistant", content },
    contextItems: [],
    ...(reasoning && { reasoning }),
  };
}

function reasoning(partial: Partial<Reasoning>): Reasoning {
  return { active: false, text: "", startAt: 0, ...partial };
}

// #12246: the model's reasoning is sent back in the field it arrived in
describe("convertFromUnifiedHistory reasoning", () => {
  it("sends reasoning_content back for the current turn", () => {
    const messages = convertFromUnifiedHistory(
      [
        user("Fix the bug"),
        assistant(
          "Reading the file",
          reasoning({
            text: "Need to read it",
            textField: "reasoning_content",
          }),
        ),
      ],
      { model: "deepseek-v4-pro" },
    );
    expect(messages[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "Need to read it",
    });
  });

  it("does not send reasoning text for earlier turns", () => {
    const messages = convertFromUnifiedHistory([
      user("First"),
      assistant(
        "One",
        reasoning({ text: "old thoughts", textField: "reasoning_content" }),
      ),
      user("Second"),
    ]);
    expect(messages[1]).not.toHaveProperty("reasoning_content");
  });

  it("uses the field the server sent", () => {
    const messages = convertFromUnifiedHistory([
      user("Hi"),
      assistant("Hello", reasoning({ text: "greet", textField: "reasoning" })),
    ]);
    expect(messages[1]).toMatchObject({ reasoning: "greet" });
    expect(messages[1]).not.toHaveProperty("reasoning_content");
  });

  it("sends signed details for every turn, and unsigned ones only for the current turn", () => {
    const signed = { type: "reasoning.text", text: "t", signature: "sig" };
    const unsigned = { type: "reasoning.summary", summary: "s" };
    const messages = convertFromUnifiedHistory(
      [
        user("First"),
        assistant("One", reasoning({ details: [signed, unsigned] })),
        user("Second"),
        assistant("Two", reasoning({ details: [signed, unsigned] })),
      ],
      { model: "gpt-5" },
    );
    expect((messages[1] as any).reasoning_details).toEqual([signed]);
    expect((messages[3] as any).reasoning_details).toEqual([signed, unsigned]);
  });

  it("omits unsigned reasoning for Claude models", () => {
    const messages = convertFromUnifiedHistory(
      [
        user("Hi"),
        assistant(
          "Hello",
          reasoning({
            text: "plain",
            textField: "reasoning",
            details: [{ type: "reasoning.text", text: "plain" }],
          }),
        ),
      ],
      { model: "anthropic/claude-sonnet-5-5" },
    );
    expect(messages[1]).not.toHaveProperty("reasoning");
    expect(messages[1]).not.toHaveProperty("reasoning_details");
  });

  it("leaves assistant messages without reasoning unchanged", () => {
    const messages = convertFromUnifiedHistory([
      user("Hi"),
      assistant("Hello"),
    ]);
    expect(messages[1]).toEqual({ role: "assistant", content: "Hello" });
  });
});
