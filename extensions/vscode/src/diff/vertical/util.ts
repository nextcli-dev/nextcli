import { DiffLine } from "core";

export function getFirstChangedLine(
  diff: DiffLine[],
  startLine: number,
): number | null {
  for (let i = 0; i < diff.length; i++) {
    const item = diff[i];
    if (item.type === "old" || item.type === "new") {
      return startLine + i;
    }
  }
  return null;
}

/**
 * Lines on each side of a diff, for rebuilding the diff over a range with
 * `myersDiff`. The range ends at the end of its last line, so its text ends
 * with "\n" only when that last line is empty; the caller then appends "\n"
 * to the rebuilt content to keep it.
 *
 * Diff lines from `streamDiffLines` come from `text.split("\n")` and already
 * include that empty last line (`myersDiff` output doesn't). Keeping it would
 * count the trailing newline twice: the document would gain a line no diff
 * entry accounts for, and rejecting the diff would leave a blank line behind.
 * So it is dropped here, from both sides.
 */
export function getRangeDiffSides(
  diffLines: DiffLine[],
  rangeText: string,
  rangeLineCount: number,
): { originalLines: string[]; newLines: string[] } {
  let originalLines = diffLines
    .filter((line) => line.type === "same" || line.type === "old")
    .map((line) => line.line);
  let newLines = diffLines
    .filter((line) => line.type === "same" || line.type === "new")
    .map((line) => line.line);

  const includesTrailingEmptyLine =
    rangeText.endsWith("\n") &&
    originalLines.length === rangeLineCount &&
    originalLines[originalLines.length - 1] === "";
  if (includesTrailingEmptyLine) {
    originalLines = originalLines.slice(0, -1);
    if (newLines[newLines.length - 1] === "") {
      newLines = newLines.slice(0, -1);
    }
  }
  return { originalLines, newLines };
}
