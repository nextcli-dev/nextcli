import type { ChatHistoryItem, ToolStatus } from "core/index.js";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderInTty } from "../../test-helpers/ttyRender.js";
import { createUITestContext } from "../../test-helpers/ui-test-context.js";
import { AppRoot } from "../AppRoot.js";

const mockUseChat = vi.fn();

vi.mock("../hooks/useChat.js", () => ({
  useChat: () => mockUseChat(),
}));

// Shown in every frame while a response runs, so it marks the live frames
const STATUS_LINE = "esc to interrupt";

function chatState(overrides: Record<string, unknown>) {
  return {
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
  };
}

function setChat(overrides: Record<string, unknown>) {
  mockUseChat.mockReturnValue(chatState(overrides));
}

const lines = (count: number, prefix: string) =>
  Array.from(
    { length: count },
    (_, i) => `${prefix} ${String(i).padStart(2, "0")}`,
  ).join("\n");

const user = (content: string): ChatHistoryItem => ({
  message: { role: "user", content },
  contextItems: [],
});

const reply = (content: string): ChatHistoryItem => ({
  message: { role: "assistant", content },
  contextItems: [],
});

/** A step with long reasoning and four tool calls, as in a large task */
function toolStep(status: ToolStatus, output?: string): ChatHistoryItem {
  return {
    message: { role: "assistant", content: "" },
    contextItems: [],
    reasoning: { active: false, text: lines(80, "thinking"), startAt: 0 },
    toolCallStates: [1, 2, 3, 4].map((n) => ({
      toolCallId: `call-${n}`,
      toolCall: {
        id: `call-${n}`,
        type: "function" as const,
        function: { name: "Read", arguments: "{}" },
      },
      status,
      parsedArgs: { filepath: `src/file${n}.ts` },
      output: output
        ? [{ name: "Tool Result", description: "", content: output }]
        : undefined,
    })),
  };
}

const app = () => React.createElement(AppRoot, {});

describe("TUIChat live area", () => {
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

  function renderApp(size?: { columns?: number; rows?: number }) {
    const rendered = renderInTty(app(), size);
    unmountApp = rendered.unmount;
    return rendered;
  }

  it("keeps every frame below the terminal height while a long step runs", async () => {
    setChat({
      chatHistory: [user("refactor the parser"), toolStep("calling")],
      isWaitingForResponse: true,
      responseStartTime: Date.now(),
    });
    const { stdout } = renderApp({ rows: 20 });

    // The spinner redraws the frame several times a second
    await vi.waitFor(
      () =>
        expect(
          stdout.writes.filter((w) => w.includes(STATUS_LINE)).length,
        ).toBeGreaterThanOrEqual(4),
      { timeout: 10_000 },
    );

    expect(stdout.tallestWriteWith(STATUS_LINE)).toBeLessThan(20);
    expect(stdout.screenClearsSince(0)).toBe(0);
    // The newest lines show, and a note says how many are above
    expect(stdout.outputSince(0)).toMatch(/↑ \d+ more lines/);
    expect(stdout.outputSince(0)).not.toContain("thinking 00");
  });

  it("prints the whole final reply once the turn ends", async () => {
    const history = [user("list them"), reply(lines(60, "- reply"))];
    setChat({
      chatHistory: history,
      isWaitingForResponse: true,
      responseStartTime: Date.now(),
    });
    const { stdout, rerender } = renderApp({ rows: 20 });
    await vi.waitFor(() =>
      expect(stdout.outputSince(0)).toContain(STATUS_LINE),
    );
    expect(stdout.outputSince(0)).not.toContain("reply 00");

    setChat({ chatHistory: history, isWaitingForResponse: false });
    rerender(app());

    await vi.waitFor(() => expect(stdout.outputSince(0)).toContain("reply 00"));
    const output = stdout.outputSince(0);
    for (let i = 0; i < 60; i++) {
      expect(output).toContain(`reply ${String(i).padStart(2, "0")}`);
    }
    expect(output.split("reply 00").length - 1).toBe(1);
  });

  it("keeps a step live until its tools finish, even after the turn stops", async () => {
    // Escape stops the turn before the running tools report back
    setChat({
      chatHistory: [user("run it"), toolStep("calling")],
      isWaitingForResponse: false,
    });
    const { stdout, rerender } = renderApp({ rows: 40 });
    await vi.waitFor(() => expect(stdout.outputSince(0)).toContain("○"));

    setChat({
      chatHistory: [
        user("run it"),
        toolStep("canceled", "Interrupted by the user"),
      ],
      isWaitingForResponse: false,
    });
    rerender(app());

    await vi.waitFor(() =>
      expect(stdout.outputSince(0)).toContain("Interrupted by the user"),
    );
  });

  it("never prints a message twice when a turn starts", async () => {
    const question = user("what does parse() return?");
    setChat({ chatHistory: [question] });
    const { stdout, rerender } = renderApp({ rows: 20 });
    await vi.waitFor(() =>
      expect(stdout.outputSince(0)).toContain("what does parse() return?"),
    );

    // The turn starts before the reply arrives, then ends
    setChat({
      chatHistory: [question],
      isWaitingForResponse: true,
      responseStartTime: Date.now(),
    });
    rerender(app());
    await vi.waitFor(() =>
      expect(stdout.outputSince(0)).toContain(STATUS_LINE),
    );
    setChat({
      chatHistory: [question, toolStep("calling")],
      isWaitingForResponse: true,
      responseStartTime: Date.now(),
    });
    rerender(app());
    setChat({
      chatHistory: [
        question,
        toolStep("done", "ok"),
        reply("It returns a tree"),
      ],
      isWaitingForResponse: false,
    });
    rerender(app());

    await vi.waitFor(() =>
      expect(stdout.outputSince(0)).toContain("It returns a tree"),
    );
    expect(
      stdout.outputSince(0).split("what does parse() return?").length - 1,
    ).toBe(1);
  });

  it("prints the history once when the terminal gets shorter mid-turn", async () => {
    setChat({
      chatHistory: [user("alpha question"), toolStep("calling")],
      isWaitingForResponse: true,
      responseStartTime: Date.now(),
    });
    const { stdout } = renderApp({ rows: 30 });
    await vi.waitFor(() =>
      expect(stdout.outputSince(0)).toContain(STATUS_LINE),
    );

    const mark = stdout.writes.length;
    stdout.resize(80, 15);

    // The resize clears the screen and prints the history again, once
    await vi.waitFor(
      () => expect(stdout.outputSince(mark)).toContain("alpha question"),
      { timeout: 10_000 },
    );
    const reprinted = stdout.writes.length;
    await vi.waitFor(
      () =>
        expect(
          stdout.writes.slice(reprinted).filter((w) => w.includes(STATUS_LINE))
            .length,
        ).toBeGreaterThanOrEqual(3),
      { timeout: 10_000 },
    );
    expect(stdout.outputSince(mark).split("alpha question").length - 1).toBe(1);
    expect(stdout.tallestWriteWith(STATUS_LINE, reprinted)).toBeLessThan(15);
  });

  it("clears the screen and prints the history again on Ctrl+L", async () => {
    setChat({ chatHistory: [user("hello there"), reply("Hi!")] });
    const { stdout, stdin } = renderApp({ rows: 20 });
    await vi.waitFor(() => expect(stdout.outputSince(0)).toContain("Hi!"));

    const mark = stdout.writes.length;
    stdin.write("\u000c");

    await vi.waitFor(() => {
      expect(stdout.screenClearsSince(mark)).toBeGreaterThan(0);
      expect(stdout.outputSince(mark)).toContain("hello there");
    });
    expect(stdout.outputSince(mark).split("hello there").length - 1).toBe(1);
  });

  it("fits a permission prompt with a long diff in a 24-row terminal", async () => {
    const diff = [
      "@@ -1,40 +1,40 @@",
      ...Array.from({ length: 40 }, (_, i) => `+const value${i} = ${i};`),
    ].join("\n");
    setChat({
      chatHistory: [user("edit it"), toolStep("generated")],
      isWaitingForResponse: true,
      responseStartTime: Date.now(),
      activePermissionRequest: {
        toolName: "Edit",
        toolArgs: { filepath: "src/a.ts" },
        requestId: "req-1",
        toolCallPreview: [{ type: "diff", content: diff }],
      },
    });
    const { stdout } = renderApp({ rows: 24 });

    await vi.waitFor(
      () =>
        expect(
          stdout.writes.filter((w) => w.includes("Would you like to continue?"))
            .length,
        ).toBeGreaterThanOrEqual(3),
      { timeout: 10_000 },
    );
    expect(stdout.tallestWriteWith("Would you like to continue?")).toBeLessThan(
      24,
    );
    expect(stdout.screenClearsSince(0)).toBe(0);
    expect(stdout.outputSince(0)).toMatch(/\.\.\. \(\d+ more lines\)/);
  });
});
