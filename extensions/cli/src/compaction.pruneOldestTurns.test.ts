import type { ChatHistoryItem } from "core/index.js";
import { describe, expect, it } from "vitest";

import { PRUNED_HISTORY_NOTE_PREFIX, pruneOldestTurns } from "./compaction.js";

const user = (content: string): ChatHistoryItem => ({
  message: { role: "user", content },
  contextItems: [],
});
const assistant = (content: string, toolCallId?: string): ChatHistoryItem => ({
  message: {
    role: "assistant",
    content,
    ...(toolCallId && {
      toolCalls: [
        {
          id: toolCallId,
          type: "function" as const,
          function: { name: "Read", arguments: "{}" },
        },
      ],
    }),
  },
  contextItems: [],
});
const tool = (toolCallId: string): ChatHistoryItem => ({
  message: { role: "tool", content: "output", toolCallId },
  contextItems: [],
});
// Contents without the note that joins the first message
const contents = (history: ChatHistoryItem[]) =>
  history.map((item) =>
    String(item.message.content).replace(/^\[Context note:[^\]]*\]\n\n/, ""),
  );
const isNote = (item: ChatHistoryItem) =>
  String(item.message.content).startsWith(PRUNED_HISTORY_NOTE_PREFIX);
const atMost = (n: number) => (history: ChatHistoryItem[]) =>
  history.length <= n;

describe("pruneOldestTurns", () => {
  it("returns a history that fits as it is", () => {
    const history = [user("u1"), assistant("a1")];

    const result = pruneOldestTurns(history, () => true);

    expect(result).toEqual({ history, removed: 0, fits: true });
  });

  it("returns an empty history as it is", () => {
    expect(pruneOldestTurns([], () => false)).toEqual({
      history: [],
      removed: 0,
      fits: false,
    });
  });

  it("drops the oldest whole turn first and keeps the newest request", () => {
    const history = [
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("a2"),
      user("u3"),
    ];

    const result = pruneOldestTurns(history, atMost(4));

    expect(result.removed).toBe(2);
    expect(isNote(result.history[0])).toBe(true);
    expect(String(result.history[0].message.content)).toContain(
      "2 earlier messages",
    );
    expect(contents(result.history)).toEqual(["u2", "a2", "u3"]);
  });

  it("drops a tool call together with its results", () => {
    const history = [
      user("u1"),
      assistant("a1", "c1"),
      tool("c1"),
      user("u2"),
      assistant("a2"),
    ];

    const result = pruneOldestTurns(history, atMost(3));

    expect(result.removed).toBe(3);
    expect(contents(result.history)).toEqual(["u2", "a2"]);
  });

  it("drops the oldest steps of one long turn and keeps its request", () => {
    // A headless run: one request, then many tool steps
    const history = [
      user("task"),
      assistant("s1", "c1"),
      tool("c1"),
      assistant("s2", "c2"),
      tool("c2"),
      assistant("s3", "c3"),
      tool("c3"),
    ];

    const result = pruneOldestTurns(history, atMost(6));

    expect(result.removed).toBe(2);
    expect(contents(result.history)).toEqual([
      "task",
      "s2",
      "output",
      "s3",
      "output",
    ]);
    // No tool result is left without its call
    expect(result.history[1].message.role).toBe("assistant");
  });

  it("keeps a leading summary and drops the turns after it", () => {
    // The summary is the only record of the conversation before it
    const summary: ChatHistoryItem = {
      ...assistant("summary"),
      conversationSummary: "summary",
    };
    const history = [
      summary,
      user("u1"),
      assistant("a1", "c1"),
      tool("c1"),
      user("u2"),
      assistant("a2"),
    ];

    const result = pruneOldestTurns(history, atMost(3));

    expect(result).toMatchObject({ removed: 3, fits: true });
    expect(result.history[0]).toBe(summary);
    expect(contents(result.history)).toEqual(["summary", "u2", "a2"]);
    expect(isNote(result.history[1])).toBe(true);
  });

  it("does not fit a summary alone that is too long", () => {
    const summary: ChatHistoryItem = {
      ...assistant("summary"),
      conversationSummary: "summary",
    };

    const result = pruneOldestTurns([summary], () => false);

    expect(result).toEqual({ history: [summary], removed: 0, fits: false });
  });

  it("keeps the newest request and the last step when nothing fits", () => {
    const history = [
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("s1", "c1"),
      tool("c1"),
      assistant("s2"),
    ];

    const result = pruneOldestTurns(history, () => false);

    expect(result.removed).toBe(4);
    expect(result.fits).toBe(false);
    expect(contents(result.history)).toEqual(["u2", "s2"]);
  });

  it("leaves a single step that does not fit unchanged", () => {
    const history = [user("u1"), assistant("a1")];

    const result = pruneOldestTurns(history, () => false);

    expect(result).toEqual({ history, removed: 0, fits: false });
  });

  it("joins the note to the first user message, so roles still alternate", () => {
    const history = [user("u1"), assistant("a1"), user("u2"), assistant("a2")];

    const result = pruneOldestTurns(history, atMost(2));

    expect(result.history.map((item) => item.message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(String(result.history[0].message.content)).toMatch(
      /^\[Context note: 2 earlier .*\]\n\nu2$/s,
    );
    // The history it came from is left as it was
    expect(history[2].message.content).toBe("u2");
  });

  it("puts the note before a message with parts as a text part", () => {
    const image: ChatHistoryItem = {
      message: {
        role: "user",
        content: [
          { type: "text", text: "u2" },
          { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AA" } },
        ],
      },
      contextItems: [],
    };
    const history = [user("u1"), assistant("a1"), image, assistant("a2")];

    const result = pruneOldestTurns(history, atMost(2));

    const parts = result.history[0].message.content as {
      type: string;
      text?: string;
    }[];
    expect(parts.map((part) => part.type)).toEqual([
      "text",
      "text",
      "imageUrl",
    ]);
    expect(isNote(result.history[0])).toBe(false);
    expect(parts[0].text).toContain(PRUNED_HISTORY_NOTE_PREFIX);
  });

  it("adds the note as its own user message before an assistant step", () => {
    // After an earlier compaction, a turn can start with assistant steps
    const history = [assistant("s1", "c1"), tool("c1"), assistant("s2")];

    const result = pruneOldestTurns(history, atMost(2));

    expect(result.removed).toBe(2);
    expect(isNote(result.history[0])).toBe(true);
    expect(result.history.map((item) => item.message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });
});
