import type { DiffLine } from "..";

const MIN_ORIGINAL_LINES = 5;
const MIN_KEPT_RATIO = 0.5;
const MIN_EXPLAINED_RATIO = 0.5;

export const DESTRUCTIVE_APPLY_WARNING =
  "The apply model replaced most of the file with content that is neither in the original nor in the suggested code. It may have written an explanation instead of code. Review the diff before accepting it.";

function normalize(line: string): string {
  return line.trim();
}

/**
 * Detects an LLM apply result that destroys the file instead of merging the
 * suggested code into it, e.g. when the apply model answers in prose or leaks
 * its reasoning (upstream #9379).
 *
 * The result is flagged only when it both drops most of the original lines and
 * consists mostly of lines found in neither the original nor the suggested
 * code. A legitimate full rewrite matches the suggested code and isn't flagged.
 */
export function isLikelyDestructiveApply(
  diffLines: DiffLine[],
  suggestedCode: string,
): boolean {
  let originalCount = 0;
  let keptCount = 0;
  const originalLines = new Set<string>();
  const outputLines: string[] = [];

  for (const diffLine of diffLines) {
    const line = normalize(diffLine.line);
    if (line === "") {
      continue;
    }
    if (diffLine.type === "same" || diffLine.type === "old") {
      originalCount++;
      originalLines.add(line);
    }
    if (diffLine.type === "same") {
      keptCount++;
    }
    if (diffLine.type === "same" || diffLine.type === "new") {
      outputLines.push(line);
    }
  }

  if (originalCount < MIN_ORIGINAL_LINES) {
    return false;
  }
  if (keptCount / originalCount >= MIN_KEPT_RATIO) {
    return false;
  }
  if (outputLines.length === 0) {
    // The file was emptied although there was code to merge into it
    return suggestedCode.trim() !== "";
  }

  const suggestedLines = new Set(
    suggestedCode.split("\n").map(normalize).filter((l) => l !== ""),
  );
  const explainedCount = outputLines.filter(
    (line) => originalLines.has(line) || suggestedLines.has(line),
  ).length;

  return explainedCount / outputLines.length < MIN_EXPLAINED_RATIO;
}
