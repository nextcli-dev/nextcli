import { RefObject, useEffect, useState } from "react";

interface ElementSize {
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  isResizing: boolean;
}

/**
 * The element's size, updated `debounceMs` after it stops resizing.
 * `isResizing` is true in between.
 */
export const useElementSize = (
  ref: RefObject<HTMLElement>,
  debounceMs = 250,
): ElementSize => {
  const [size, setSize] = useState<ElementSize>({
    clientWidth: 0,
    clientHeight: 0,
    scrollWidth: 0,
    scrollHeight: 0,
    isResizing: false,
  });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // One pending update: a new measurement replaces it, and unmounting
    // cancels it, so no state update runs after the component is gone
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const updateSize = () => {
      const measurements = {
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
      };
      setSize((prev) =>
        prev.isResizing ? prev : { ...prev, isResizing: true },
      );
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        setSize({ ...measurements, isResizing: false });
      }, debounceMs);
    };

    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(element);
    updateSize();

    return () => {
      resizeObserver.disconnect();
      clearTimeout(timeoutId);
    };
  }, [ref, debounceMs]);

  return size;
};
