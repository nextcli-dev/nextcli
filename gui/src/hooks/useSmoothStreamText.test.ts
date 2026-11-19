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

/** Moves both clocks: performance.now and the fake timers */
function wait(ms: number) {
  now += ms;
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** One animation frame, FRAME_MS after the last; timers due by then run first */
function frame() {
  wait(FRAME_MS);
  const callbacks = [...frames.values()];
  frames.clear();
  act(() => callbacks.forEach((cb) => cb(now)));
}

type Paint = { at: number; text: string };

/** Renders the hook and records each change of its result, with its time */
function render(initial: string) {
  const paints: Paint[] = [];
  const hook = renderHook(
    ({ source }) => {
      const shown = useSmoothStreamText(source);
      if (shown !== (paints.at(-1)?.text ?? initial)) {
        paints.push({ at: now, text: shown });
      }
      return shown;
    },
    { initialProps: { source: initial } },
  );
  return {
    hook,
    paints,
    shown: () => hook.result.current,
    set: (source: string) => hook.rerender({ source }),
    /** Runs frames until the text is caught up (or `max` frames) */
    settle(max = 60) {
      for (let i = 0; i < max && frames.size > 0; i++) frame();
    },
  };
}

const gaps = (paints: Paint[]) =>
  paints.slice(1).map((p, i) => p.at - paints[i].at);

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

  it("types in a burst over about REVEAL_MS, a word at a time", () => {
    const burst = words(40);
    const r = render("");
    const start = now;
    r.set(burst);
    expect(r.shown()).toBe("");

    r.settle();
    expect(r.shown()).toBe(burst);
    // Several steps, each at least an interval after the last
    expect(r.paints.length).toBeGreaterThanOrEqual(3);
    for (const gap of gaps(r.paints)) {
      expect(gap).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
    }
    // Neither cut short (e.g. by the fallback timer) nor dragged out
    const finished = r.paints.at(-1)!.at - start;
    expect(finished).toBeGreaterThanOrEqual(REVEAL_MS - FRAME_MS);
    expect(finished).toBeLessThanOrEqual(REVEAL_MS + 2 * MIN_INTERVAL_MS);
    // Every step but the last ends just after a word's space
    for (const { text } of r.paints.slice(0, -1)) {
      expect(text.endsWith(" ")).toBe(true);
    }
  });

  it("shows replaced text at once", () => {
    const r = render("First answer");
    r.set("Something else");
    expect(r.shown()).toBe("Something else");
    expect(frames.size).toBe(0);
  });

  it("updates long text less often than short text, but still in steps", () => {
    expect(updateIntervalMs(200)).toBe(MIN_INTERVAL_MS);
    expect(updateIntervalMs(5_000)).toBe(50);
    expect(updateIntervalMs(50_000)).toBe(MAX_INTERVAL_MS);

    const burst = " " + words(60);
    const reveal = (base: string) => {
      const r = render(base);
      r.set(base + burst);
      r.settle();
      expect(r.shown()).toBe(base + burst);
      return r.paints;
    };

    const long = reveal("x ".repeat(10_000)); // 20k chars: 120 ms apart
    expect(long.length).toBeGreaterThanOrEqual(2);
    for (const gap of gaps(long)) {
      expect(gap).toBeGreaterThanOrEqual(MAX_INTERVAL_MS);
    }

    const short = reveal("Short. "); // 33 ms apart
    expect(short.length).toBeGreaterThan(long.length);
  });

  it.each([
    ["long", "x ".repeat(10_000), MAX_INTERVAL_MS, 20],
    ["short", "Short answer. ", MIN_INTERVAL_MS, 10],
  ])(
    "waits out the interval for a chunk that arrives after a %s text caught up",
    (_, base, interval, gapMs) => {
      const r = render(base);
      r.set(base + "Intro. ");
      r.settle();
      expect(frames.size).toBe(0);
      const caughtUp = r.paints.at(-1)!.at;

      // A word-sized chunk shortly after: one update, an interval later,
      // with its trailing space (no second update for the space alone)
      wait(gapMs);
      r.set(base + "Intro. Hello ");
      r.settle();
      const hello = r.paints.filter((p) => p.at > caughtUp);
      expect(hello).toHaveLength(1);
      expect(hello[0].text).toBe(base + "Intro. Hello ");
      expect(hello[0].at - caughtUp).toBeGreaterThanOrEqual(interval);

      // And the next one again
      wait(gapMs);
      r.set(base + "Intro. Hello world ");
      r.settle();
      const world = r.paints.filter((p) => p.at > hello[0].at);
      expect(world).toHaveLength(1);
      expect(world[0].at - hello[0].at).toBeGreaterThanOrEqual(interval);
    },
  );

  it("lands the full text when no animation frames run, not before", () => {
    const r = render("");
    r.set(words(30));
    now += FALLBACK_MS - 1;
    act(() => {
      vi.advanceTimersByTime(FALLBACK_MS - 1);
    });
    expect(r.shown()).toBe("");
    now += 1;
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(r.shown()).toBe(words(30));
  });

  it("keeps following a source that grows while it reveals", () => {
    const r = render("");
    let source = "";
    for (let i = 0; i < 10; i++) {
      source += `chunk${i} `;
      r.set(source);
      frame();
    }
    r.settle();
    expect(r.shown()).toBe(source);
    for (const gap of gaps(r.paints)) {
      expect(gap).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
    }
  });

  it("stops requesting frames once caught up and on unmount", () => {
    const r = render("");
    r.set("short");
    r.settle();
    expect(r.shown()).toBe("short");
    expect(frames.size).toBe(0);

    r.set("short and more");
    expect(frames.size).toBe(1);
    r.hook.unmount();
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

  it("ends just after a word's space when one is close", () => {
    // Stretched past "defgh" and its space
    expect(nextRevealEnd("abc defgh ijk", 0, 7)).toBe(10);
    // Already just after a space: stays
    expect(nextRevealEnd("abc defgh ijk", 0, 4)).toBe(4);
    // "Hello " in full, not "Hello" and a later update for the space
    expect(nextRevealEnd("Hi. Hello ", 4, 3)).toBe(10);
    // Too far to the next space: cut mid-word
    const longWord = "a".repeat(10) + "b".repeat(40) + " c";
    expect(nextRevealEnd(longWord, 0, 18)).toBe(18);
  });
});
