import { useEffect, useRef, useState } from "react";

/**
 * Follows `value`, but changes at most once per `intervalMs`. The first
 * change goes through at once; changes inside the interval are coalesced and
 * the latest one lands when it ends, so the result always settles on the
 * current value.
 */
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastEmit = useRef(0);
  const emitted = useRef(value);

  useEffect(() => {
    // Mounting, or settling back on what was shown, isn't a change
    if (Object.is(value, emitted.current)) return;
    const emit = () => {
      lastEmit.current = Date.now();
      emitted.current = value;
      setThrottled(value);
    };
    const wait = intervalMs - (Date.now() - lastEmit.current);
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
