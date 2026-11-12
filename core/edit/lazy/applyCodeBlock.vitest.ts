import { describe, expect, it } from "vitest";
import { DiffLine, ILLM } from "../..";
import { applyCodeBlock } from "./applyCodeBlock";

const NEW =
  "function mul(a, b) {\n  // multiply\n  return a * b;\n}\n\nmodule.exports = { mul };\n";

async function collect(generator: AsyncGenerator<DiffLine>) {
  const lines: DiffLine[] = [];
  for await (const line of generator) {
    lines.push(line);
  }
  return lines;
}

describe("applyCodeBlock", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])(
    "applies a full rewrite of a %s file instantly, without the model",
    async (_, eol) => {
      const oldFile = [
        "function mul(a, b) {",
        "  return a * b;",
        "}",
        "",
        "module.exports = { mul };",
        "",
      ].join(eol);

      const { isInstantApply, diffLinesGenerator } = await applyCodeBlock(
        oldFile,
        NEW,
        "math.js",
        {} as ILLM, // not called on the instant path
        new AbortController(),
      );

      expect(isInstantApply).toBe(true);
      expect(await collect(diffLinesGenerator)).toEqual([
        { type: "same", line: "function mul(a, b) {" },
        { type: "new", line: "  // multiply" },
        { type: "same", line: "  return a * b;" },
        { type: "same", line: "}" },
        { type: "same", line: "" },
        { type: "same", line: "module.exports = { mul };" },
      ]);
    },
  );
});
