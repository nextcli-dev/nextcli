import type { ModelConfig } from "@nextcli/config-yaml";
import type { ChatHistoryItem } from "core/index.js";
import { describe, expect, it } from "vitest";

import { taskToKeep } from "./turnContinuation.js";

// A quarter of this window, 1000 tokens, is the most a kept prompt may use
const model: ModelConfig = {
  name: "test",
  provider: "openai",
  model: "gpt-4",
  defaultCompletionOptions: { contextLength: 4000, maxTokens: 500 },
};

function item(
  role: "user" | "assistant",
  content: ChatHistoryItem["message"]["content"],
): ChatHistoryItem {
  return { message: { role, content } as any, contextItems: [] };
}

describe("taskToKeep", () => {
  it("keeps the run's prompt, the last user message", () => {
    const history = [
      item("user", "an earlier session's question"),
      item("assistant", "its answer"),
      item("user", "Review this pull request. Answer in JSON."),
    ];

    expect(taskToKeep(history, model)).toBe(
      "Review this pull request. Answer in JSON.",
    );
  });

  it("keeps the text of a prompt with images", () => {
    const history = [
      item("user", [
        { type: "text", text: "What is in" },
        { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AAAA" } },
        { type: "text", text: "this picture?" },
      ]),
    ];

    expect(taskToKeep(history, model)).toBe("What is in\nthis picture?");
  });

  it("keeps nothing when the prompt is over a quarter of the window", () => {
    const long = "word ".repeat(2000);

    expect(taskToKeep([item("user", long)], model)).toBeUndefined();
    expect(taskToKeep([item("user", "word ".repeat(200))], model)).toBe(
      "word ".repeat(200),
    );
  });

  it("keeps nothing without a user message with text", () => {
    expect(taskToKeep([], model)).toBeUndefined();
    expect(taskToKeep([item("assistant", "hello")], model)).toBeUndefined();
    expect(taskToKeep([item("user", "  ")], model)).toBeUndefined();
  });
});
