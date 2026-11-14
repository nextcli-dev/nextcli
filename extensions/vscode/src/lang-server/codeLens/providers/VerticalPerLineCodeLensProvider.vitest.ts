import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
    translate(lineDelta = 0) {
      return new Position(this.line + lineDelta, this.character);
    }
  }
  class Range {
    constructor(
      public start: Position,
      public end: Position,
    ) {}
  }
  class CodeLens {
    constructor(
      public range: Range,
      public command: { title: string; command: string; arguments: unknown[] },
    ) {}
  }
  class EventEmitter {
    event = () => ({ dispose() {} });
    fire() {}
  }
  return { Position, Range, CodeLens, EventEmitter };
});

import { VerticalDiffCodeLensProvider } from "./VerticalPerLineCodeLensProvider";

const URI = "file:///workspace/hello.txt";
const documentAt = (uri: string) => ({ uri: { toString: () => uri } }) as any;

describe("VerticalDiffCodeLensProvider", () => {
  it("gives each diff block an Accept and a Reject lens for that block", () => {
    const blocks = new Map([
      [
        URI,
        [
          { start: 1, numGreen: 1, numRed: 1 },
          { start: 5, numGreen: 2, numRed: 0 },
        ],
      ],
    ]);
    const lenses = new VerticalDiffCodeLensProvider(blocks).provideCodeLenses(
      documentAt(URI),
      {} as any,
    ) as any[];

    expect(
      lenses.map((lens) => [
        lens.command.title,
        lens.command.command,
        lens.command.arguments,
        [lens.range.start.line, lens.range.end.line],
      ]),
    ).toEqual([
      ["Accept", "continue.acceptVerticalDiffBlock", [URI, 0], [1, 3]],
      ["Reject", "continue.rejectVerticalDiffBlock", [URI, 0], [1, 3]],
      ["Accept", "continue.acceptVerticalDiffBlock", [URI, 1], [5, 7]],
      ["Reject", "continue.rejectVerticalDiffBlock", [URI, 1], [5, 7]],
    ]);
  });

  it("gives no lenses for a file without a diff", () => {
    const provider = new VerticalDiffCodeLensProvider(
      new Map([[URI, [{ start: 0, numGreen: 1, numRed: 0 }]]]),
    );
    expect(
      provider.provideCodeLenses(documentAt("file:///other.txt"), {} as any),
    ).toEqual([]);
  });
});
