import type { ChatHistoryItem } from "core/index.js";
import { render as renderInk } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { EditMessageSelector } from "./EditMessageSelector.js";

describe("EditMessageSelector restore key", () => {
  const history: ChatHistoryItem[] = [
    { message: { role: "user", content: "first" }, contextItems: [] },
    { message: { role: "assistant", content: "ok" }, contextItems: [] },
    { message: { role: "user", content: "second" }, contextItems: [] },
  ];

  it("offers r and opens the restore screen for a message with a snapshot", async () => {
    const onRestore = vi.fn();
    const { lastFrame, stdin } = renderInk(
      <EditMessageSelector
        chatHistory={history}
        onEdit={vi.fn()}
        onExit={vi.fn()}
        canRestore={(index) => index === 2}
        onRestore={onRestore}
      />,
    );
    expect(lastFrame()).toContain("r to restore files from before it");

    stdin.write("r");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onRestore).toHaveBeenCalledWith(2);
  });

  it("ignores r for a message without a snapshot", async () => {
    const onRestore = vi.fn();
    const { lastFrame, stdin } = renderInk(
      <EditMessageSelector
        chatHistory={history}
        onEdit={vi.fn()}
        onExit={vi.fn()}
        canRestore={() => false}
        onRestore={onRestore}
      />,
    );
    expect(lastFrame()).not.toContain("r to restore");

    stdin.write("r");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onRestore).not.toHaveBeenCalled();
  });
});
