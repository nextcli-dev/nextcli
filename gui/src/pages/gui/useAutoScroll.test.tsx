import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionSlice";
import { useAutoScroll } from "./useAutoScroll";

let resizeCallbacks: (() => void)[] = [];

class FakeResizeObserver {
  constructor(callback: () => void) {
    resizeCallbacks.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** A scroll container with a settable content height (jsdom has no layout) */
function makeContainer() {
  const elem = document.createElement("div");
  elem.appendChild(document.createElement("div"));
  let contentHeight = 1000;
  Object.defineProperty(elem, "clientHeight", { get: () => 400 });
  Object.defineProperty(elem, "scrollHeight", { get: () => contentHeight });
  let scrollTop = 0;
  Object.defineProperty(elem, "scrollTop", {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = Math.max(0, Math.min(v, contentHeight - 400));
    },
  });
  document.body.appendChild(elem);
  return {
    elem,
    /** The content grows, e.g. reasoning streams in */
    grow(by: number) {
      contentHeight += by;
      resizeCallbacks.forEach((cb) => cb());
    },
    /** The user scrolls to a position */
    userScrollTo(top: number) {
      elem.scrollTop = top;
      elem.dispatchEvent(new Event("scroll"));
    },
    /** The scrollTop of the very end */
    bottom() {
      return contentHeight - 400;
    },
  };
}

const userMsg = (id: string) =>
  ({
    message: { id, role: "user", content: "q" },
    contextItems: [],
  }) as ChatHistoryItemWithMessageId;

describe("useAutoScroll", () => {
  beforeEach(() => {
    resizeCallbacks = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  function setup() {
    const container = makeContainer();
    const ref = { current: container.elem };
    const hook = renderHook(({ history }) => useAutoScroll(ref, history), {
      initialProps: { history: [userMsg("u1")] },
    });
    return { ...container, hook };
  }

  it("follows growing content while the user is at the end", () => {
    const c = setup();
    expect(c.elem.scrollTop).toBe(c.bottom());
    c.grow(300);
    expect(c.elem.scrollTop).toBe(c.bottom());
  });

  it("stops following after the user scrolls up, and resumes at the end", () => {
    const c = setup();
    c.userScrollTo(c.bottom() - 200);
    c.grow(300);
    expect(c.elem.scrollTop).toBe(c.bottom() - 500);

    // Close enough to the end counts as at the end
    c.userScrollTo(c.bottom() - 10);
    c.grow(300);
    expect(c.elem.scrollTop).toBe(c.bottom());
  });

  it("returns to the end on a new user message", () => {
    const c = setup();
    c.userScrollTo(0);
    c.grow(300);
    expect(c.elem.scrollTop).toBe(0);

    c.hook.rerender({ history: [userMsg("u1"), userMsg("u2")] });
    expect(c.elem.scrollTop).toBe(c.bottom());
    c.grow(300);
    expect(c.elem.scrollTop).toBe(c.bottom());
  });
});
