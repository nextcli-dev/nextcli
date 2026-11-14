import { JSONContent } from "@tiptap/react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useInputHistory } from "./useInputHistory";

const doc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

function setup() {
  const hook = renderHook(() => useInputHistory("test"));
  const add = (text: string) =>
    act(() => {
      hook.result.current.addRef.current(doc(text));
    });
  // ArrowUp passes the editor's current content, kept as the draft
  const prev = (draft = doc("")) => {
    let out: JSONContent | undefined;
    act(() => {
      out = hook.result.current.prevRef.current(draft);
    });
    return out;
  };
  const next = () => {
    let out: JSONContent | undefined;
    act(() => {
      out = hook.result.current.nextRef.current();
    });
    return out;
  };
  return { hook, add, prev, next };
}

describe("useInputHistory", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("walks back through sent inputs and forward to the unsent draft", () => {
    const { add, prev, next } = setup();
    add("first");
    add("second");
    add("third");

    expect(prev(doc("draft"))).toEqual(doc("third"));
    expect(prev()).toEqual(doc("second"));
    expect(prev()).toEqual(doc("first"));
    // Nothing older than the first input
    expect(prev()).toBeUndefined();

    expect(next()).toEqual(doc("second"));
    expect(next()).toEqual(doc("third"));
    // Past the newest input comes back what was typed before ArrowUp
    expect(next()).toEqual(doc("draft"));
    expect(next()).toBeUndefined();
  });

  it("doesn't store the same input twice in a row", () => {
    const { add, prev } = setup();
    add("again");
    add("again");

    expect(prev()).toEqual(doc("again"));
    expect(prev()).toBeUndefined();
  });

  it("keeps history for the same key across editors", () => {
    setup().add("remembered");

    const { prev } = setup();
    expect(prev()).toEqual(doc("remembered"));
  });
});
