import { useEffect, useRef, useState } from "react";

/** A burst of streamed text is typed in over about this long */
export const REVEAL_MS = 100;
/** Fastest and slowest update interval; longer text updates less often.
 * About 30 updates a second already types smoothly, at half the parsing of
 * every frame. */
export const MIN_INTERVAL_MS = 33;
export const MAX_INTERVAL_MS = 120;
/** Text still behind this long after the source last changed (no animation
 * frames, e.g. a hidden panel) lands in full. A quiet-period timer, not a
 * bound on lag: each change restarts it. */
export const FALLBACK_MS = 250;
/** How far a step may stretch to end on a word */
const WORD_LOOKAHEAD = 12;

/**
 * Each update re-renders the whole text (markdown, math, highlighting), so
 * longer text updates less often: about 30 times a second for a short
 * answer, a few times a second for a long one.
 */
export function updateIntervalMs(length: number) {
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, length / 100));
}

/**
 * The end of the next prefix of `target` to show: `chars` more than
 * `shownLength`, stretched past the end of a word when one is close
 */
export function nextRevealEnd(
  target: string,
  shownLength: number,
  chars: number,
) {
  const end = shownLength + Math.max(1, Math.ceil(chars));
  if (end >= target.length) return target.length;
  if (target[end - 1] === " ") return end;
  // End after a word's space rather than mid-word, when one is close.
  // Including the space matters: a chunk such as "Hello " would otherwise
  // leave its space for a separate update, and re-parse, of its own.
  const space = target.indexOf(" ", end);
  if (space !== -1 && space - end <= WORD_LOOKAHEAD) return space + 1;
  return end;
}

/**
 * Follows a streaming `source` the way a chat types out a reply: text that
 * grows is revealed over a few animation frames, so a burst of chunks types
 * in instead of landing at once, and updates are spaced by
 * `updateIntervalMs`. Text that is replaced rather than appended to shows at
 * once. The result always settles on `source`.
 */
export function useSmoothStreamText(source: string): string {
  const [shown, setShown] = useState(source);
  const shownRef = useRef(source);
  const targetRef = useRef(source);
  const lastEmitRef = useRef(0);
  // The reveal is linear in time from the last chunk: from anchorLength at
  // anchorTime, at a rate that shows everything so far in REVEAL_MS
  const rateRef = useRef(0);
  const anchorLengthRef = useRef(0);
  const anchorTimeRef = useRef(0);
  const frameRef = useRef<number | undefined>(undefined);
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const show = (text: string) => {
    shownRef.current = text;
    lastEmitRef.current = performance.now();
    setShown(text);
  };

  const cancel = () => {
    if (frameRef.current !== undefined) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
    }
    clearTimeout(fallbackRef.current);
    fallbackRef.current = undefined;
  };

  // Recreated each render, but only reads refs, so a pending frame calling
  // an older copy behaves the same
  const tick = () => {
    frameRef.current = undefined;
    // Not the frame's timestamp: it can come from another clock, or start
    // before the last update made during the previous frame
    const now = performance.now();
    const target = targetRef.current;
    const shownLength = shownRef.current.length;
    if (shownLength >= target.length) {
      cancel();
      return;
    }
    const interval = updateIntervalMs(target.length);
    if (now - lastEmitRef.current >= interval) {
      // Where the reveal should be by now, so late frames don't slow it
      const due =
        anchorLengthRef.current +
        rateRef.current * (now - anchorTimeRef.current);
      show(
        target.slice(0, nextRevealEnd(target, shownLength, due - shownLength)),
      );
    }
    if (shownRef.current.length < target.length) {
      frameRef.current = requestAnimationFrame(tick);
    } else {
      cancel();
    }
  };

  useEffect(() => {
    targetRef.current = source;
    if (source === shownRef.current) {
      cancel();
      return;
    }
    if (!source.startsWith(shownRef.current)) {
      cancel();
      show(source);
      return;
    }
    // Each chunk sets the pace that shows everything so far in REVEAL_MS
    const now = performance.now();
    anchorLengthRef.current = shownRef.current.length;
    anchorTimeRef.current = now;
    rateRef.current = (source.length - shownRef.current.length) / REVEAL_MS;
    // Starting from rest, tick still spaces updates from the last one: an
    // old update lets the next frame show a step, a recent one waits out
    // its interval, so a chunk after a catch-up can't re-parse early
    if (frameRef.current === undefined) {
      frameRef.current = requestAnimationFrame(tick);
    }
    // Without animation frames the text would never land; restarted on
    // each change, so it only fires once the source stops changing
    clearTimeout(fallbackRef.current);
    fallbackRef.current = setTimeout(() => {
      fallbackRef.current = undefined;
      if (shownRef.current !== targetRef.current) {
        cancel();
        show(targetRef.current);
      }
    }, FALLBACK_MS);
  }, [source]);

  useEffect(() => cancel, []);

  return shown;
}
