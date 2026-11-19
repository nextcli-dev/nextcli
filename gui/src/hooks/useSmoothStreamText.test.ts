import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_MS,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  nextRevealEnd,
  REVEAL_MS,
  updateIntervalMs,
  useSmoothStreamText,
} from "./useSmoothStreamText";

const FRAME_MS = 16;
let frames: Map<number, FrameRequestCallback>;
let nextFrameId = 1;
let now = 1000;

/** Runs one animation frame, FRAME_MS after the last */
function frame() {
  now += FRAME_MS;
  const callbacks = [...frames.values()];
  frames.clear();
  act(() => callbacks.forEach((cb) => cb(now)));
}

function render(initial: string) {
  return renderHook(({ source }) => useSmoothStreamText(source), {
    initialProps: { source: initial },
  });
}

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

describe("useSmoothStreamText", () => {
  beforeEach(() => {
    frames = new Map();
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("types in a burst over a few frames and reaches the full text", () => {
    const burst = words(40);
    const hook = render("");
    hook.rerender({ source: burst });
    expect(hook.result.current).toBe("");

    const lengths: number[] = [];
    for (let i = 0; i < 20 && hook.result.current !== burst; i++) {
      frame();
      lengths.push(hook.result.current.length);
    }
    expect(hook.result.current).toBe(burst);
    // Finished about REVEAL_MS after the burst, give or take an update
    expect(lengths.length * FRAME_MS).toBeLessThanOrEqual(
      REVEAL_MS + 2 * MIN_INTERVAL_MS,
    );
    // Several growing steps, not one jump
    expect(new Set(lengths).size).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1]);
    }
    // Steps end on a word
    const firstStep = burst.slice(0, lengths[0]);
    expect(burst[firstStep.length] ?? " ").toBe(" ");
  });

  it("shows replaced text at once", () => {
    const hook = render("First answer");
    hook.rerender({ source: "Something else" });
    expect(hook.result.current).toBe("Something else");
    expect(frames.size).toBe(0);
  });

  it("updates long text less often than short text", () => {
    expect(updateIntervalMs(200)).toBe(MIN_INTERVAL_MS);
    expect(updateIntervalMs(5_000)).toBe(50);
    expect(updateIntervalMs(50_000)).toBe(MAX_INTERVAL_MS);

    const long = "x ".repeat(10_000); // 20k chars, interval 120 ms
    const hook = render(long);
    let renders = 0;
    let previous = hook.result.current;
    hook.rerender({ source: long + words(50) });
    for (let i = 0; i < 30; i++) {
      frame();
      if (hook.result.current !== previous) {
        renders++;
        previous = hook.result.current;
      }
    }
    // 30 frames are 480 ms: at most one update per 120 ms
    expect(renders).toBeGreaterThan(0);
    expect(renders).toBeLessThanOrEqual(Math.ceil((30 * FRAME_MS) / 120));
    expect(hook.result.current).toBe(long + words(50));
  });

  it("lands the full text when no animation frames run", () => {
    const hook = render("");
    hook.rerender({ source: words(30) });
    act(() => {
      vi.advanceTimersByTime(FALLBACK_MS);
    });
    expect(hook.result.current).toBe(words(30));
  });

  it("keeps following a source that grows while it reveals", () => {
    const hook = render("");
    let source = "";
    for (let i = 0; i < 10; i++) {
      source += `chunk${i} `;
      hook.rerender({ source });
      frame();
    }
    for (let i = 0; i < 10; i++) frame();
    expect(hook.result.current).toBe(source);
  });

  it("stops requesting frames once caught up and on unmount", () => {
    const hook = render("");
    hook.rerender({ source: "short" });
    for (let i = 0; i < 10; i++) frame();
    expect(hook.result.current).toBe("short");
    expect(frames.size).toBe(0);

    hook.rerender({ source: "short and more" });
    expect(frames.size).toBe(1);
    hook.unmount();
    expect(frames.size).toBe(0);
  });
});

describe("nextRevealEnd", () => {
  it("moves on by the given number of characters, never past the end", () => {
    const target = "a".repeat(600);
    expect(nextRevealEnd(target, 0, 200)).toBe(200);
    expect(nextRevealEnd(target, 590, 200)).toBe(600);
    // Always at least one character
    expect(nextRevealEnd(target, 10, 0.2)).toBe(11);
  });

  it("stretches to the end of a word only when it is close", () => {
    expect(nextRevealEnd("abc defgh ijk", 0, 7)).toBe(9);
    const longWord = "a".repeat(10) + "b".repeat(40) + " c";
    expect(nextRevealEnd(longWord, 0, 18)).toBe(18);
  });
});
