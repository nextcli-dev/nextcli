import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useElementSize } from "./useElementSize";

describe("useElementSize", () => {
  let resize: () => void;
  const element = {
    clientWidth: 100,
    clientHeight: 50,
    scrollWidth: 100,
    scrollHeight: 80,
  } as HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    global.ResizeObserver = vi.fn().mockImplementation((callback) => {
      resize = () => callback([], {} as ResizeObserver);
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the size once the element stops resizing", () => {
    // A stable ref, as useRef gives a component
    const ref = { current: element };
    const { result } = renderHook(() => useElementSize(ref, 250));
    expect(result.current.isResizing).toBe(true);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    (element as any).clientHeight = 70;
    act(() => {
      resize();
    });
    // The second measurement restarts the wait
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.isResizing).toBe(true);

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current).toEqual({
      clientWidth: 100,
      clientHeight: 70,
      scrollWidth: 100,
      scrollHeight: 80,
      isResizing: false,
    });
  });

  // A pending update after unmount ran once the test environment was gone
  // ("window is not defined" from React's scheduler)
  it("leaves no pending update after unmounting", () => {
    const ref = { current: element };
    const { unmount } = renderHook(() => useElementSize(ref, 250));
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
