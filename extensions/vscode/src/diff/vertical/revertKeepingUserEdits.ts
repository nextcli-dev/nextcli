import { diffChars, diffLines } from "diff";

/**
 * Reverts the handler's own edits while keeping the user's.
 *
 * - `original`: the document before the handler touched it
 * - `base`: the document right after the handler's last own edit
 * - `current`: the document now (`base` plus the user's edits)
 *
 * The agent's changes are `base -> original` (line diff); the user's are
 * `base -> current` (char diff). Each user change is moved onto `original`:
 * text the user typed is always kept, and where it was typed inside text the
 * agent added (which disappears), it lands where that text was. User deletions
 * only remove text that exists in `original`.
 */
export function revertKeepingUserEdits(
  original: string,
  base: string,
  current: string,
): string {
  if (current === base) {
    return original;
  }
  const map = buildBaseToOriginalMap(base, original);
  const edits: TextEdit[] = [];
  let seq = 0;

  for (const change of diffUserChanges(base, current)) {
    if (change.deleteEnd > change.start) {
      for (const [start, end] of map.originalRangesIn(
        change.start,
        change.deleteEnd,
      )) {
        edits.push({ start, end, text: "", seq: seq++ });
      }
    }
    if (change.insert) {
      const at = map.toOriginal(change.start);
      edits.push({ start: at, end: at, text: change.insert, seq: seq++ });
    }
  }

  return applyEdits(original, edits);
}

interface TextEdit {
  start: number;
  end: number;
  text: string;
  /** Order the edit was produced in, to keep same-position inserts in order */
  seq: number;
}

/** Applies non-overlapping edits given in `original` offsets */
function applyEdits(text: string, edits: TextEdit[]): string {
  // From the end, so earlier offsets stay valid. At the same position a
  // deletion goes before an insertion (or it would remove the inserted text),
  // and later insertions before earlier ones (so they end up in typing order)
  const sorted = [...edits].sort(
    (a, b) =>
      b.start - a.start ||
      Number(a.end === a.start) - Number(b.end === b.start) ||
      b.seq - a.seq,
  );
  let result = text;
  for (const edit of sorted) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

interface Segment {
  baseStart: number;
  baseEnd: number;
  originalStart: number;
  /** Text present in both: offsets map one to one */
  equal: boolean;
}

function buildBaseToOriginalMap(base: string, original: string) {
  const segments: Segment[] = [];
  let baseOffset = 0;
  let originalOffset = 0;
  for (const part of diffLines(base, original)) {
    const length = part.value.length;
    if (part.added) {
      // Only in `original` (e.g. lines the agent removed)
      originalOffset += length;
    } else if (part.removed) {
      // Only in `base`: text the agent added
      segments.push({
        baseStart: baseOffset,
        baseEnd: baseOffset + length,
        originalStart: originalOffset,
        equal: false,
      });
      baseOffset += length;
    } else {
      segments.push({
        baseStart: baseOffset,
        baseEnd: baseOffset + length,
        originalStart: originalOffset,
        equal: true,
      });
      baseOffset += length;
      originalOffset += length;
    }
  }
  const originalLength = original.length;

  return {
    /** Where a position in `base` lands in `original` */
    toOriginal(offset: number): number {
      for (const segment of segments) {
        if (offset >= segment.baseStart && offset < segment.baseEnd) {
          return segment.equal
            ? segment.originalStart + (offset - segment.baseStart)
            : segment.originalStart;
        }
      }
      return originalLength;
    },
    /** The parts of `base` range [start, end) that exist in `original` */
    originalRangesIn(start: number, end: number): [number, number][] {
      const ranges: [number, number][] = [];
      for (const segment of segments) {
        if (!segment.equal) {
          continue;
        }
        const from = Math.max(start, segment.baseStart);
        const to = Math.min(end, segment.baseEnd);
        if (from < to) {
          const offset = segment.originalStart - segment.baseStart;
          ranges.push([from + offset, to + offset]);
        }
      }
      return ranges;
    },
  };
}

interface UserChange {
  /** Position in `base` */
  start: number;
  /** End of the deleted `base` text; equal to `start` for a pure insertion */
  deleteEnd: number;
  insert: string;
}

function diffUserChanges(base: string, current: string): UserChange[] {
  // Keystrokes are small and local: diff only the part that differs
  let prefix = 0;
  const maxPrefix = Math.min(base.length, current.length);
  while (prefix < maxPrefix && base[prefix] === current[prefix]) {
    prefix++;
  }
  let suffix = 0;
  const maxSuffix = Math.min(base.length, current.length) - prefix;
  while (
    suffix < maxSuffix &&
    base[base.length - 1 - suffix] === current[current.length - 1 - suffix]
  ) {
    suffix++;
  }
  const baseMiddle = base.slice(prefix, base.length - suffix);
  const currentMiddle = current.slice(prefix, current.length - suffix);

  const changes: UserChange[] = [];
  let offset = prefix;
  for (const part of diffChars(baseMiddle, currentMiddle)) {
    const last = changes[changes.length - 1];
    if (part.removed) {
      if (last && last.deleteEnd === offset && !last.insert) {
        last.deleteEnd += part.value.length;
      } else {
        changes.push({
          start: offset,
          deleteEnd: offset + part.value.length,
          insert: "",
        });
      }
      offset += part.value.length;
    } else if (part.added) {
      if (last && last.deleteEnd === offset) {
        last.insert += part.value;
      } else {
        changes.push({ start: offset, deleteEnd: offset, insert: part.value });
      }
    } else {
      offset += part.value.length;
    }
  }
  return changes;
}
