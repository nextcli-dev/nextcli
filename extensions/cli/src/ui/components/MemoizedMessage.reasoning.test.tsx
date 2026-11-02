import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";

import type { ChatHistoryItem } from "../../../../../core/index.js";

import { MemoizedMessage } from "./MemoizedMessage.js";

function assistantItem(text?: string): ChatHistoryItem {
  return {
    message: { role: "assistant", content: "The answer is 42." },
    contextItems: [],
    ...(text !== undefined && {
      reasoning: { active: false, text, startAt: 0 },
    }),
  };
}

describe("MemoizedMessage reasoning", () => {
  it("shows the reasoning above the reply", () => {
    const { lastFrame } = render(
      <MemoizedMessage item={assistantItem("Compute 6 times 7.")} index={1} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Thinking");
    expect(frame).toContain("Compute 6 times 7.");
    expect(frame.indexOf("Compute 6 times 7.")).toBeLessThan(
      frame.indexOf("The answer is 42."),
    );
  });

  it("shows nothing extra for signature-only reasoning", () => {
    const { lastFrame } = render(
      <MemoizedMessage item={assistantItem("")} index={1} />,
    );
    expect(lastFrame()).not.toContain("Thinking");
    expect(lastFrame()).toContain("The answer is 42.");
  });

  it("hides the reasoning when Show thinking is off", () => {
    const { lastFrame } = render(
      <MemoizedMessage
        item={assistantItem("Compute 6 times 7.")}
        index={1}
        showReasoning={false}
      />,
    );
    expect(lastFrame()).not.toContain("Compute 6 times 7.");
    expect(lastFrame()).toContain("The answer is 42.");
  });

  it("re-renders when Show thinking changes", () => {
    const item = assistantItem("Compute 6 times 7.");
    const { lastFrame, rerender } = render(
      <MemoizedMessage item={item} index={1} showReasoning={true} />,
    );
    expect(lastFrame()).toContain("Compute 6 times 7.");
    rerender(<MemoizedMessage item={item} index={1} showReasoning={false} />);
    expect(lastFrame()).not.toContain("Compute 6 times 7.");
  });

  it("shows a reasoning-only reply without an empty bullet or cursor", () => {
    const item: ChatHistoryItem = {
      message: { role: "assistant", content: "" },
      contextItems: [],
      reasoning: { active: false, text: "Nothing to add.", startAt: 0 },
    };
    const { lastFrame } = render(
      <MemoizedMessage item={item} index={1} showReasoning={true} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Nothing to add.");
    expect(frame).not.toContain("●");
    expect(frame).not.toContain("▋");
  });
});
