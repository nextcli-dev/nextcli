import type { ChatHistoryItem, ContextItemWithId } from "core";
import { describe, expect, it } from "vitest";
import {
  getContextItemsFromHistory,
  selectPastContextItems,
} from "./updateFileSymbols";

function file(name: string): ContextItemWithId {
  return {
    name,
    description: name,
    content: "",
    id: { providerTitle: "file", itemId: name },
    uri: { type: "file", value: `file:///repo/${name}` },
  };
}

function user(content: string, files: string[] = []): ChatHistoryItem {
  return {
    message: { role: "user", content },
    contextItems: files.map(file),
  };
}

function toolbar(content: string, name: string): ChatHistoryItem {
  return {
    message: { role: "user", content },
    contextItems: [],
    editorState: {
      type: "doc",
      content: [{ type: "codeBlock", attrs: { item: file(name) } }],
    },
  };
}

const assistant = (content: string): ChatHistoryItem => ({
  message: { role: "assistant", content },
  contextItems: [],
});

describe("selectPastContextItems", () => {
  const history = [
    user("q1", ["a.ts"]),
    assistant("a1"),
    toolbar("q2", "b.ts"),
    assistant("a2"),
    user("q3", ["c.ts", "d.ts"]),
    assistant("streaming"),
  ];

  it("matches getContextItemsFromHistory at every index", () => {
    const entries = selectPastContextItems(history);
    history.forEach((_, i) => {
      expect(entries[i]).toEqual(getContextItemsFromHistory(history, i));
    });
  });

  it("returns the same list for the same history", () => {
    expect(selectPastContextItems(history)).toBe(
      selectPastContextItems(history),
    );
  });

  it("keeps every earlier entry when only the streaming item changes", () => {
    const before = selectPastContextItems(history);
    const next = [...history.slice(0, -1), assistant("streaming more")];
    const after = selectPastContextItems(next);

    expect(after).not.toBe(before);
    for (let i = 0; i < history.length - 1; i++) {
      expect(after[i]).toBe(before[i]);
    }
    // An item without context items shares the entry before it
    expect(after[5]).toBe(after[4]);
  });
});
