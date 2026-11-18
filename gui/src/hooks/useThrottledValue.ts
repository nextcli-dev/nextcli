import { useEffect, useRef, useState } from "react";

/**
 * Follows `value`, but changes at most once per `intervalMs`. The first
 * change goes through at once; changes inside the interval are coalesced and
 * the latest one lands when it ends, so the result always settles on the
 * current value.
 *
 * With `isGrowth`, only changes it accepts are throttled (e.g. a streaming
 * text that grows); any other change lands at once.
 */
export function useThrottledValue<T>(
  value: T,
  intervalMs: number,
  isGrowth?: (previous: T, next: T) => boolean,
): T {
  const [throttled, setThrottled] = useState(value);
  const lastEmit = useRef(0);
  const emitted = useRef(value);
  const isGrowthRef = useRef(isGrowth);
  isGrowthRef.current = isGrowth;

  useEffect(() => {
    // Mounting, or settling back on what was shown, isn't a change
    if (Object.is(value, emitted.current)) return;
    const emit = () => {
      lastEmit.current = Date.now();
      emitted.current = value;
      setThrottled(value);
    };
    const grows = isGrowthRef.current?.(emitted.current, value) ?? true;
    const wait = grows ? intervalMs - (Date.now() - lastEmit.current) : 0;
    if (wait <= 0) {
      emit();
      return;
    }
    const timer = setTimeout(emit, wait);
    // A newer value replaces this one before it lands
    return () => clearTimeout(timer);
  }, [value, intervalMs]);

  return throttled;
}
