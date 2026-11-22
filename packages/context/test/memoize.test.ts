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

  it("does not store a single text longer than maxChars", () => {
    const wrapped = vi.fn(count);
    const cached = memoizeCount(wrapped, { maxChars: 800, minChars: 100 });
    const text = "c".repeat(900);
    cached(text);
    cached(text);
    expect(wrapped).toHaveBeenCalledTimes(2);
  });
});
