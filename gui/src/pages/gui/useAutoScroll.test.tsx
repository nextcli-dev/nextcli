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
function makeContainer(initialHeight = 1000) {
  const elem = document.createElement("div");
  elem.appendChild(document.createElement("div"));
  let contentHeight = initialHeight;
  Object.defineProperty(elem, "clientHeight", { get: () => 400 });
  Object.defineProperty(elem, "scrollHeight", {
    get: () => Math.max(contentHeight, 400),
  });
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
    /** The content grows, but the observers haven't run yet */
    growUnobserved(by: number) {
      contentHeight += by;
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

  function setup(initialHeight?: number) {
    const container = makeContainer(initialHeight);
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

  it("keeps following when content grows before our own scroll event fires", () => {
    const c = setup();
    c.grow(300);
    // The scroll event from that scroll-to-end arrives after more content
    // rendered, so the view is no longer at the end when it is handled
    c.growUnobserved(300);
    c.elem.dispatchEvent(new Event("scroll"));
    c.grow(300);
    expect(c.elem.scrollTop).toBe(c.bottom());
  });

  it("stops following at once on a wheel up", () => {
    const c = setup();
    c.elem.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    const position = c.elem.scrollTop;
    c.grow(300);
    expect(c.elem.scrollTop).toBe(position);

    // A wheel down doesn't let go
    c.userScrollTo(c.bottom());
    c.elem.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
    c.grow(300);
    expect(c.elem.scrollTop).toBe(c.bottom());
  });

  it("keeps following when a nested box takes the wheel up", () => {
    const c = setup();
    // The live reasoning box: scrolls vertically, scrolled down a bit
    const reasoning = document.createElement("div");
    reasoning.style.overflowY = "auto";
    Object.defineProperty(reasoning, "scrollTop", { value: 120 });
    const line = document.createElement("p");
    reasoning.appendChild(line);
    c.elem.firstElementChild!.appendChild(reasoning);

    line.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
    c.grow(300);
    expect(c.elem.scrollTop).toBe(c.bottom());
  });

  it("lets go on a wheel up through a box that only scrolls sideways", () => {
    const c = setup();
    // Terminal output: scrolls horizontally, its scrollTop is irrelevant
    const terminal = document.createElement("div");
    terminal.style.overflowX = "scroll";
    terminal.style.overflowY = "hidden";
    Object.defineProperty(terminal, "scrollTop", { value: 30 });
    c.elem.firstElementChild!.appendChild(terminal);

    terminal.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -40, bubbles: true }),
    );
    const position = c.elem.scrollTop;
    c.grow(300);
    expect(c.elem.scrollTop).toBe(position);
  });

  it("keeps following after a wheel up in a chat that fits the panel", () => {
    // Nothing to scroll: no scroll event follows the wheel either
    const c = setup(300);
    expect(c.elem.scrollTop).toBe(0);
    c.elem.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    c.grow(500);
    expect(c.elem.scrollTop).toBe(c.bottom());
  });

  it("resumes following on a wheel down at the end", () => {
    const c = setup();
    c.elem.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    // Released at the end: the next growth stays put, then the user wheels
    // down where nothing scrolls
    c.grow(300);
    expect(c.elem.scrollTop).toBe(c.bottom() - 300);
    c.userScrollTo(c.bottom());
    c.elem.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    c.elem.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
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
