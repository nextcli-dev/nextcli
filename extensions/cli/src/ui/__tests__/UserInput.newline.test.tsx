import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UserInput } from "../UserInput.js";

// Terminals set up for Shift+Enter (VS Code, iTerm2 and others) send ESC+CR,
// which Ink 7 and later report as meta+return
const SHIFT_ENTER_AS_ESC_CR = "\u001b\r";

function renderInput() {
  const onSubmit = vi.fn();
  const { stdin, lastFrame, unmount } = render(
    <UserInput
      onSubmit={onSubmit}
      inputMode={true}
      disabled={false}
      isWaitingForResponse={false}
    />,
  );
  return { stdin, lastFrame, unmount, onSubmit };
}

describe("UserInput new lines", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("adds a new line on ESC+CR and submits both lines on Enter", async () => {
    const { stdin, lastFrame, unmount, onSubmit } = renderInput();
    try {
      stdin.write("first");
      stdin.write(SHIFT_ENTER_AS_ESC_CR);
      stdin.write("second");
      await vi.waitFor(() => expect(lastFrame()).toContain("second"));
      expect(onSubmit).not.toHaveBeenCalled();

      stdin.write("\r");
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.calls[0][0]).toBe("first\nsecond");
    } finally {
      unmount();
    }
  });

  it("submits on a plain Enter", async () => {
    const { stdin, unmount, onSubmit } = renderInput();
    try {
      stdin.write("only line");
      stdin.write("\r");
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit.mock.calls[0][0]).toBe("only line");
    } finally {
      unmount();
    }
  });
});
