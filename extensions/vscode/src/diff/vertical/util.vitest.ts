import { DiffLine } from "core";
import { myersDiff } from "core/diff/myers";
import { describe, expect, it } from "vitest";

import { getRangeDiffSides } from "./util";

/**
 * Replays VerticalDiffHandler.reapplyWithMyersDiff on a whole-file range,
 * then rejects or accepts every block the way the handler does.
 */
function applyThen(
  original: string,
  diffLines: DiffLine[],
  action: "reject" | "accept",
): string {
  const docLines = original.split("\n");
  const { originalLines, newLines } = getRangeDiffSides(
    diffLines,
    original,
    docLines.length,
  );
  const diffs = myersDiff(
    originalLines.join("\n") + "\n",
    newLines.join("\n") + "\n",
  );
  const lines = (
    diffs.map((d) => (d.type === "old" ? "" : d.line)).join("\n") +
    (original.endsWith("\n") ? "\n" : "")
  ).split("\n");

  const result: string[] = [];
  diffs.forEach((d, i) => {
    if (d.type === "same") result.push(lines[i]);
    if (d.type === "old" && action === "reject") result.push(d.line);
    if (d.type === "new" && action === "accept") result.push(lines[i]);
  });
  // Lines after the diffed entries (the range's empty last line)
  result.push(...lines.slice(diffs.length));
  return result.join("\n");
}

const CONFIG =
  "name: cfg\nversion: 1.0.0\nmodels:\n  - name: A\n    model: a\n";
const PROSE = "The user wants me to apply an edit.\nCould you clarify?";

describe("getRangeDiffSides round trip", () => {
  // streamDiffLines output: built from text.split("\n"), so it ends with ""
  const streamStyle: DiffLine[] = [
    ...PROSE.split("\n").map((line) => ({ type: "new" as const, line })),
    ...CONFIG.split("\n").map((line) => ({ type: "old" as const, line })),
  ];

  it("reject restores the file exactly (the incident)", () => {
    expect(applyThen(CONFIG, streamStyle, "reject")).toBe(CONFIG);
  });

  it("accept keeps the trailing newline", () => {
    expect(applyThen(CONFIG, streamStyle, "accept")).toBe(PROSE + "\n");
  });

  it("handles myersDiff-style lines (no trailing empty line)", () => {
    const updated = CONFIG.replace("model: a", "model: b");
    const lines = myersDiff(CONFIG, updated);
    expect(applyThen(CONFIG, lines, "reject")).toBe(CONFIG);
    expect(applyThen(CONFIG, lines, "accept")).toBe(updated);
  });

  it("handles a file without a trailing newline", () => {
    const original = "a\nb";
    const lines: DiffLine[] = [
      { type: "same", line: "a" },
      { type: "old", line: "b" },
      { type: "new", line: "c" },
    ];
    expect(applyThen(original, lines, "reject")).toBe(original);
    expect(applyThen(original, lines, "accept")).toBe("a\nc");
  });

  it("keeps a real blank last line", () => {
    const original = "a\n\n";
    const lines: DiffLine[] = original
      .split("\n")
      .map((line) => ({ type: "old" as const, line }));
    lines.unshift({ type: "new", line: "x" });
    expect(applyThen(original, lines, "reject")).toBe(original);
    expect(applyThen(original, lines, "accept")).toBe("x\n");
  });
});
