import { describe, expect, it } from "vitest";

import { revertKeepingUserEdits } from "./revertKeepingUserEdits";

// The agent replaces line2 and line3 with X1..X3. Mid-stream, the handler has
// turned the removed lines into empty placeholders (red, hidden) followed by
// the streamed lines (green)
const ORIGINAL = "line1\nline2\nline3\nline4\n";
const BASE = "line1\n\n\nX1\nX2\nX3\nline4\n";
// Where the agent's block sits in ORIGINAL: right after "line1\n"
const BLOCK = "line1\n".length;

const insertAt = (text: string, at: number, insert: string) =>
  text.slice(0, at) + insert + text.slice(at);

describe("revertKeepingUserEdits", () => {
  it("returns the original when the user changed nothing", () => {
    expect(revertKeepingUserEdits(ORIGINAL, BASE, BASE)).toBe(ORIGINAL);
  });

  it("keeps a newline typed in the middle of a multi-line green block", () => {
    const current = BASE.replace("X1\nX2", "X1\n\nX2");
    const result = revertKeepingUserEdits(ORIGINAL, BASE, current);
    expect(result).toBe(insertAt(ORIGINAL, BLOCK, "\n"));
    expect(result).not.toContain("X");
  });

  it("keeps a character typed inside a green line", () => {
    const current = BASE.replace("X2", "XZ2");
    expect(revertKeepingUserEdits(ORIGINAL, BASE, current)).toBe(
      insertAt(ORIGINAL, BLOCK, "Z"),
    );
  });

  it("keeps text typed on a hidden red placeholder line", () => {
    const current = BASE.replace("line1\n\n", "line1\ntyped\n");
    expect(revertKeepingUserEdits(ORIGINAL, BASE, current)).toBe(
      insertAt(ORIGINAL, BLOCK, "typed"),
    );
  });

  it("keeps typing outside the agent's changes in place", () => {
    const current = BASE.replace("line4", "ZZZline4");
    expect(revertKeepingUserEdits(ORIGINAL, BASE, current)).toBe(
      ORIGINAL.replace("line4", "ZZZline4"),
    );
  });

  it("applies a deletion only to the text that exists in the original", () => {
    // Select from inside line1 into X1 and delete it
    const from = "lin".length;
    const to = BASE.indexOf("X1") + 1;
    const current = BASE.slice(0, from) + BASE.slice(to);
    expect(revertKeepingUserEdits(ORIGINAL, BASE, current)).toBe(
      "lin" + ORIGINAL.slice(BLOCK),
    );
  });

  it("keeps several separate edits", () => {
    const current = BASE.replace("line1", "line1!").replace("line4", "line4?");
    expect(revertKeepingUserEdits(ORIGINAL, BASE, current)).toBe(
      "line1!\nline2\nline3\nline4?\n",
    );
  });

  it("keeps typing order for insertions that land in the same place", () => {
    const current = BASE.replace("X1", "XA1").replace("X3", "XB3");
    expect(revertKeepingUserEdits(ORIGINAL, BASE, current)).toBe(
      insertAt(ORIGINAL, BLOCK, "AB"),
    );
  });

  it("keeps a replacement typed over original text", () => {
    const current = BASE.replace("line4", "LINE4");
    expect(revertKeepingUserEdits(ORIGINAL, BASE, current)).toBe(
      ORIGINAL.replace("line4", "LINE4"),
    );
  });
});
