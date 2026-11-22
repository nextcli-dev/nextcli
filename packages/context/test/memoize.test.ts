import { describe, expect, it, vi } from "vitest";

import { memoizeCount } from "../src/index.js";

const count = (text: string) => text.length;

describe("memoizeCount", () => {
  it("returns the same values as the wrapped function", () => {
    const wrapped = vi.fn(count);
    const cached = memoizeCount(wrapped);
    const samples = ["short", "x".repeat(512), "y".repeat(2_000)];
    for (const sample of samples) {
      expect(cached(sample)).toBe(count(sample));
    }
  });

  it("counts a repeated long text once", () => {
    const wrapped = vi.fn(count);
    const cached = memoizeCount(wrapped);
    const text = "z".repeat(600);
    expect(cached(text)).toBe(600);
    expect(cached(text)).toBe(600);
    expect(wrapped).toHaveBeenCalledTimes(1);
  });

  it("does not cache short texts", () => {
    const wrapped = vi.fn(count);
    const cached = memoizeCount(wrapped, { minChars: 512 });
    const text = "q".repeat(511);
    cached(text);
    cached(text);
    expect(wrapped).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entries once maxChars is passed", () => {
    const wrapped = vi.fn(count);
    const cached = memoizeCount(wrapped, { maxChars: 1_000, minChars: 500 });
    const first = "a".repeat(600);
    const second = "b".repeat(600);
    cached(first);
    cached(second);
    cached(second);
    expect(wrapped).toHaveBeenCalledTimes(2);
    cached(first);
    expect(wrapped).toHaveBeenCalledTimes(3);
  });

  it("moves a hit to the newest end", () => {
    const wrapped = vi.fn(count);
    const cached = memoizeCount(wrapped, { maxChars: 1_200, minChars: 500 });
    const first = "a".repeat(600);
    const second = "b".repeat(600);
    const third = "c".repeat(600);
    cached(first);
    cached(second);
    cached(first);
    cached(third);
    cached(first);
    expect(wrapped).toHaveBeenCalledTimes(3);
    cached(second);
    expect(wrapped).toHaveBeenCalledTimes(4);
  });

  it("caches a zero count", () => {
    const wrapped = vi.fn(() => 0);
    const cached = memoizeCount(wrapped, { minChars: 100 });
    const text = "z".repeat(600);
    expect(cached(text)).toBe(0);
    expect(cached(text)).toBe(0);
    expect(wrapped).toHaveBeenCalledTimes(1);
  });

  it("does not keep NaN or undefined in the budget", () => {
    const nan = vi.fn();
    nan.mockReturnValueOnce(Number.NaN).mockReturnValueOnce(4);
    const cachedNan = memoizeCount(nan, { minChars: 100 });
    const nanText = "n".repeat(600);
    expect(cachedNan(nanText)).toBeNaN();
    expect(cachedNan(nanText)).toBe(4);

    const missing = vi.fn();
    missing.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined);
    missing.mockReturnValue(5);
    const cachedMissing = memoizeCount(missing, {
      maxChars: 1_000,
      minChars: 100,
    });
    const bad = "u".repeat(600);
    cachedMissing(bad);
    cachedMissing(bad);
    const good = "g".repeat(600);
    expect(cachedMissing(good)).toBe(5);
    expect(cachedMissing(good)).toBe(5);
    expect(missing).toHaveBeenCalledTimes(3);
  });

  it("does not store a single text longer than maxChars", () => {
    const wrapped = vi.fn(count);
    const cached = memoizeCount(wrapped, { maxChars: 800, minChars: 100 });
    const text = "c".repeat(900);
    cached(text);
    cached(text);
    expect(wrapped).toHaveBeenCalledTimes(2);
  });
});
