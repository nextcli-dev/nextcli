import type { ChatHistoryItem } from "core/index.js";
import { describe, expect, it } from "vitest";

import { fitHistory, PRUNED_HISTORY_NOTE_PREFIX } from "./fitHistory.js";

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

describe("fitHistory", () => {
  it("returns a history that fits as it is", () => {
    const history = [user("u1"), assistant("a1")];

    const result = fitHistory(history, () => true);

    expect(result).toEqual({ history, removed: 0, shortened: 0, fits: true });
  });

  it("returns an empty history as it is", () => {
    expect(fitHistory([], () => false)).toEqual({
      history: [],
      removed: 0,
      shortened: 0,
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

    const result = fitHistory(history, atMost(4));

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

    const result = fitHistory(history, atMost(3));

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

    const result = fitHistory(history, atMost(6));

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

    const result = fitHistory(history, atMost(3));

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

    const result = fitHistory([summary], () => false);

    expect(result).toEqual({
      history: [summary],
      removed: 0,
      shortened: 0,
      fits: false,
    });
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

    const result = fitHistory(history, () => false);

    expect(result.removed).toBe(4);
    expect(result.fits).toBe(false);
    expect(contents(result.history)).toEqual(["u2", "s2"]);
  });

  it("leaves a single step that does not fit unchanged", () => {
    const history = [user("u1"), assistant("a1")];

    const result = fitHistory(history, () => false);

    expect(result).toEqual({ history, removed: 0, shortened: 0, fits: false });
  });

  it("joins the note to the first user message, so roles still alternate", () => {
    const history = [user("u1"), assistant("a1"), user("u2"), assistant("a2")];

    const result = fitHistory(history, atMost(2));

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

    const result = fitHistory(history, atMost(2));

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

    const result = fitHistory(history, atMost(2));

    expect(result.removed).toBe(2);
    expect(isNote(result.history[0])).toBe(true);
    expect(result.history.map((item) => item.message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  describe("tool outputs", () => {
    const big = "x".repeat(10_000);
    const step = (content: string, id: string, output: string) =>
      ({
        message: { role: "assistant", content },
        contextItems: [],
        toolCallStates: [
          {
            toolCallId: id,
            toolCall: {
              id,
              type: "function",
              function: { name: "Read", arguments: "{}" },
            },
            status: "done",
            parsedArgs: {},
            output: [{ name: "Read", description: "", content: output }],
          },
        ],
      }) as unknown as ChatHistoryItem;
    const outputOf = (item: ChatHistoryItem) =>
      item.toolCallStates![0].output![0].content;
    // Characters of messages and tool outputs
    const size = (history: ChatHistoryItem[]) =>
      history.reduce(
        (sum, item) =>
          sum +
          String(item.message.content).length +
          (item.toolCallStates?.[0]?.output?.[0]?.content.length ?? 0),
        0,
      );
    const atMostChars = (n: number) => (history: ChatHistoryItem[]) =>
      size(history) <= n;

    it("cuts an older output only as far as needed before leaving out any message", () => {
      const history = [
        user("u1"),
        step("a1", "c1", big),
        user("u2"),
        step("a2", "c2", "ok"),
      ];
      const room = size(history) - 5_000;

      const result = fitHistory(history, atMostChars(room));

      expect(result).toMatchObject({ removed: 0, shortened: 1, fits: true });
      expect(contents(result.history)).toEqual(["u1", "a1", "u2", "a2"]);
      const output = outputOf(result.history[1]);
      expect(output).toMatch(/^x+/);
      expect(output).toContain("tool output truncated");
      // The largest cap that fits: about 5,000 characters, not a fixed excerpt
      expect(output.length).toBeGreaterThan(4_500);
      expect(size(result.history)).toBeLessThanOrEqual(room);
      // The history it came from is left as it was
      expect(outputOf(history[1])).toBe(big);
    });

    it("cuts the largest output first and leaves a short one whole", () => {
      const short = "z".repeat(3_000);
      const history = [
        user("u1"),
        step("a1", "c1", short),
        user("u2"),
        step("a2", "c2", big),
        user("u3"),
        assistant("done"),
      ];

      const result = fitHistory(history, atMostChars(size(history) - 5_000));

      expect(result).toMatchObject({ removed: 0, shortened: 1, fits: true });
      expect(outputOf(result.history[1])).toBe(short);
      expect(outputOf(result.history[3])).not.toBe(big);
    });

    it("cuts an output under 4,000 characters instead of leaving its turn out", () => {
      const history = [
        user("u1"),
        step("a1", "c1", "x".repeat(3_999)),
        user("u2"),
      ];

      const result = fitHistory(history, atMostChars(size(history) - 1_000));

      expect(result).toMatchObject({ removed: 0, shortened: 1, fits: true });
      expect(contents(result.history)).toEqual(["u1", "a1", "u2"]);
    });

    it("leaves older turns out before cutting the newest step's output", () => {
      const history = [
        user("u1"),
        step("a1", "c1", big),
        assistant("y".repeat(6_000)),
        user("u2"),
        step("a2", "c2", big),
      ];

      const result = fitHistory(history, atMostChars(10_500));

      // a1's output was cut and then its turn left out, so it isn't counted
      expect(result).toMatchObject({ removed: 3, shortened: 0, fits: true });
      expect(contents(result.history)).toEqual(["u2", "a2"]);
      expect(outputOf(result.history[1])).toBe(big);
    });

    it("cuts the newest step's output when nothing else can go", () => {
      const history = [user("task"), step("a1", "c1", big)];

      const result = fitHistory(history, atMostChars(3_000));

      expect(result).toMatchObject({ removed: 0, shortened: 1, fits: true });
      expect(contents(result.history)).toEqual(["task", "a1"]);
      expect(size(result.history)).toBeLessThanOrEqual(3_000);
    });

    it("fits a kept summary beside a step whose output alone fills the room", () => {
      // Each fits alone; together they did not, and nothing could be left out
      const summary: ChatHistoryItem = {
        ...assistant("s".repeat(3_000)),
        conversationSummary: "s".repeat(3_000),
      };
      const history = [summary, user("go on"), step("a1", "c1", big)];

      const result = fitHistory(history, atMostChars(10_000));

      expect(result).toMatchObject({ removed: 0, shortened: 1, fits: true });
      expect(result.history[0]).toBe(summary);
      expect(contents(result.history).slice(1)).toEqual(["go on", "a1"]);
    });

    it("never cuts text that isn't tool output", () => {
      const reply = "y".repeat(5_000);
      const history = [user("u1"), assistant(reply)];

      const result = fitHistory(history, atMostChars(1_000));

      expect(result).toMatchObject({ removed: 0, shortened: 0, fits: false });
      expect(result.history[1].message.content).toBe(reply);
    });

    it("stops cutting at the floor and leaves older turns out instead", () => {
      const history = [
        user("u1"),
        step("a1", "c1", big),
        user("u2"),
        step("a2", "c2", "ok"),
      ];

      // Even a 500-character excerpt of a1's output is too much
      const result = fitHistory(history, atMostChars(300));

      expect(result).toMatchObject({ removed: 2, shortened: 0, fits: true });
      expect(contents(result.history)).toEqual(["u2", "a2"]);
    });
  });
});
