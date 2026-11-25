import type { ChatHistoryItem } from "core/index.js";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderInTty } from "../../test-helpers/ttyRender.js";
import { createUITestContext } from "../../test-helpers/ui-test-context.js";
import { AppRoot } from "../AppRoot.js";

const mockUseChat = vi.fn();

vi.mock("../hooks/useChat.js", () => ({
  useChat: () => mockUseChat(),
}));

function setChat(overrides: Record<string, unknown>) {
  mockUseChat.mockReturnValue({
    chatHistory: [],
    setChatHistory: vi.fn(),
    isWaitingForResponse: false,
    responseStartTime: null,
    isCompacting: false,
    compactionStartTime: null,
    inputMode: true,
    attachedFiles: [],
    activePermissionRequest: null,
    activeQuizQuestion: null,
    wasInterrupted: false,
    queuedMessages: [],
    handleUserMessage: vi.fn(),
    handleInterrupt: vi.fn(),
    handleFileAttached: vi.fn(),
    resetChatHistory: vi.fn(),
    handleEditMessage: vi.fn(),
    handleRestore: vi.fn(),
    handleToolPermissionResponse: vi.fn(),
    handleQuizAnswer: vi.fn(),
    ...overrides,
  });
}

const item = (
  role: "user" | "assistant" | "system",
  content: string,
): ChatHistoryItem => ({ message: { role, content }, contextItems: [] });

const app = () => React.createElement(AppRoot, {});

describe("TUIChat after a compaction", () => {
  let context: ReturnType<typeof createUITestContext>;
  let unmountApp: (() => void) | undefined;

  beforeEach(() => {
    context = createUITestContext({
      allServicesReady: true,
      serviceState: "ready",
    });
  });

  afterEach(() => {
    unmountApp?.();
    unmountApp = undefined;
    context.cleanup();
  });

  it("prints the compaction notice when the history gets shorter mid-turn", async () => {
    const before = Array.from({ length: 12 }, (_, i) =>
      item(i % 2 ? "assistant" : "user", `turn ${i}`),
    );
    setChat({
      chatHistory: before,
      isWaitingForResponse: true,
      responseStartTime: Date.now(),
    });
    const rendered = renderInTty(app(), { rows: 40 });
    unmountApp = rendered.unmount;
    const { stdout, rerender } = rendered;
    await vi.waitFor(() => expect(stdout.outputSince(0)).toContain("turn 10"));

    // The compaction replaces the 12 items with 4
    const mark = stdout.writes.length;
    const summary: ChatHistoryItem = {
      ...item("assistant", "the summary"),
      conversationSummary: "the summary",
    };
    setChat({
      chatHistory: [
        summary,
        item("system", "Chat history auto-compacted successfully."),
        item("user", "Continue from where the summary above leaves off."),
        item("assistant", "next step"),
      ],
      isWaitingForResponse: false,
    });
    rerender(app());

    await vi.waitFor(() =>
      expect(stdout.outputSince(mark)).toContain("next step"),
    );
    const after = stdout.outputSince(mark);
    expect(
      after.split("Chat history auto-compacted successfully.").length - 1,
    ).toBe(1);
    expect(after).toContain("Continue from where the summary above");
    // Nothing is erased: a 2J alone wipes the screen in xterm.js (VS Code,
    // Cursor) without saving it to the scrollback. The compacted history
    // prints below the earlier turns, which aren't printed again.
    expect(stdout.screenClearsSince(mark)).toBe(0);
    expect(stdout.outputSince(0).split("turn 0").length - 1).toBe(1);
    expect(stdout.outputSince(0).indexOf("next step")).toBeGreaterThan(
      stdout.outputSince(0).lastIndexOf("turn 10"),
    );
  });

  it("drops the live reply on Escape without clearing the screen", async () => {
    setChat({
      chatHistory: [item("user", "question"), item("assistant", "partial")],
      isWaitingForResponse: true,
      responseStartTime: Date.now(),
    });
    const rendered = renderInTty(app(), { rows: 40 });
    unmountApp = rendered.unmount;
    const { stdout, rerender } = rendered;
    await vi.waitFor(() => expect(stdout.outputSince(0)).toContain("partial"));

    // handleInterrupt removes a last assistant message with no tool calls
    const mark = stdout.writes.length;
    setChat({
      chatHistory: [item("user", "question")],
      isWaitingForResponse: false,
    });
    rerender(app());
    setChat({
      chatHistory: [item("user", "question"), item("user", "next question")],
    });
    rerender(app());

    await vi.waitFor(() =>
      expect(stdout.outputSince(mark)).toContain("next question"),
    );
    expect(stdout.screenClearsSince(mark)).toBe(0);
    // The question before it isn't printed again
    expect(
      stdout.outputSince(mark).replace(/next question/g, ""),
    ).not.toContain("question");
  });
});
