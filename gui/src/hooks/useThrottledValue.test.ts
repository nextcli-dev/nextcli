import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useThrottledValue } from "./useThrottledValue";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it("starts with the value and passes the first change straight through", () => {
  const { result, rerender } = renderHook(
    ({ value }) => useThrottledValue(value, 100),
    { initialProps: { value: "a" } },
  );
  expect(result.current).toBe("a");
  rerender({ value: "ab" });
  expect(result.current).toBe("ab");
});

it("coalesces changes inside the interval and lands the latest", () => {
  const { result, rerender } = renderHook(
    ({ value }) => useThrottledValue(value, 100),
    { initialProps: { value: "" } },
  );
  rerender({ value: "1" });
  expect(result.current).toBe("1");

  for (const value of ["12", "123", "1234"]) {
    act(() => {
      vi.advanceTimersByTime(10);
    });
    rerender({ value });
  }
  // Still inside the interval: nothing new yet
  expect(result.current).toBe("1");

  act(() => {
    vi.advanceTimersByTime(100);
  });
  expect(result.current).toBe("1234");
});

it("updates at most once per interval during a steady stream", () => {
  const { result, rerender } = renderHook(
    ({ value }) => useThrottledValue(value, 100),
    { initialProps: { value: 0 } },
  );
  const seen = new Set<number>();
  for (let i = 1; i <= 100; i++) {
    act(() => {
      vi.advanceTimersByTime(10);
    });
    rerender({ value: i });
    seen.add(result.current);
  }
  act(() => {
    vi.advanceTimersByTime(100);
  });
  seen.add(result.current);
  // 1000 ms of updates every 10 ms: about 10 distinct values, not 100
  expect(seen.size).toBeLessThanOrEqual(13);
  expect(result.current).toBe(100);
});
