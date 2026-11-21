import type { ChatHistoryItem } from "core/index.js";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { EditMessageSelector } from "../EditMessageSelector.js";

const history: ChatHistoryItem[] = [
  { message: { role: "user", content: "fix the bug" }, contextItems: [] },
  { message: { role: "assistant", content: "Done" }, contextItems: [] },
];

describe("EditMessageSelector new lines", () => {
  it("adds a new line on ESC+CR while editing and submits on Enter", async () => {
    const onEdit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <EditMessageSelector
        chatHistory={history}
        onEdit={onEdit}
        onExit={vi.fn()}
      />,
    );
    try {
      // Enter starts editing the selected message
      stdin.write("\r");
      await vi.waitFor(() =>
        expect(lastFrame()).toContain("Shift+Enter for newline"),
      );

      // Shift+Enter as many terminals send it: ESC+CR (meta+return)
      stdin.write("\u001b\r");
      stdin.write("in auth.ts");
      await vi.waitFor(() => expect(lastFrame()).toContain("in auth.ts"));
      expect(onEdit).not.toHaveBeenCalled();

      stdin.write("\r");
      await vi.waitFor(() => expect(onEdit).toHaveBeenCalled());
      expect(onEdit).toHaveBeenCalledWith(0, "fix the bug\nin auth.ts");
    } finally {
      unmount();
    }
  });
});
