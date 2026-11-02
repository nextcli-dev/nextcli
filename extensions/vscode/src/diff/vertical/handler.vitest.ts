import { describe, expect, it, vi } from "vitest";

// Minimal in-memory implementation of the vscode API used by the handler
vi.mock("vscode", () => {
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
    translate(lineDelta = 0, characterDelta = 0) {
      return new Position(
        this.line + lineDelta,
        this.character + characterDelta,
      );
    }
    with(line?: number, character?: number) {
      return new Position(line ?? this.line, character ?? this.character);
    }
  }
  class Range {
    start: Position;
    end: Position;
    constructor(a: any, b: any, c?: number, d?: number) {
      if (typeof a === "number") {
        this.start = new Position(a, b);
        this.end = new Position(c!, d!);
      } else {
        this.start = a;
        this.end = b;
      }
    }
    get isEmpty() {
      return (
        this.start.line === this.end.line &&
        this.start.character === this.end.character
      );
    }
    with(start?: Position, end?: Position) {
      return new Range(start ?? this.start, end ?? this.end);
    }
  }
  const window = {
    activeTextEditor: undefined as any,
    visibleTextEditors: [] as any[],
    createTextEditorDecorationType: () => ({ dispose() {} }),
    showWarningMessage: vi.fn(),
    showTextDocument: vi.fn(),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
  };
  return {
    Position,
    Range,
    Selection: Range,
    window,
    workspace: {
      onDidChangeTextDocument: () => ({ dispose() {} }),
      openTextDocument: vi.fn(),
    },
    commands: { executeCommand: vi.fn() },
    DecorationRangeBehavior: { ClosedClosed: 1 },
    TextEditorRevealType: { Default: 0 },
  };
});

import * as vscode from "vscode";
import { streamDiff } from "core/diff/streamDiff";
import { filterLeadingAndTrailingNewLineInsertion } from "core/autocomplete/filtering/streamTransforms/lineStream";
import { VerticalDiffHandler } from "./handler";

/** An editor backed by a string, applying edits like VS Code does */
function createEditor(initial: string) {
  let text = initial;
  const lines = () => text.split("\n");
  const offsetAt = (pos: vscode.Position) => {
    const ls = lines();
    if (pos.line >= ls.length) return text.length;
    let offset = 0;
    for (let i = 0; i < pos.line; i++) offset += ls[i].length + 1;
    return offset + Math.min(pos.character, ls[pos.line].length);
  };
  const document = {
    uri: { toString: () => "file:///sandbox/.continue/config.yaml" },
    get lineCount() {
      return lines().length;
    },
    lineAt: (i: number) => ({ text: lines()[i] }),
    getText: (range?: vscode.Range) =>
      range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text,
    validateRange: (range: vscode.Range) => {
      const ls = lines();
      const endLine = Math.min(range.end.line, ls.length - 1);
      return new vscode.Range(
        range.start,
        new vscode.Position(
          endLine,
          Math.min(range.end.character, ls[endLine].length),
        ),
      );
    },
  };
  const editor: any = {
    document,
    selection: new vscode.Range(0, 0, 0, 0),
    setDecorations() {},
    revealRange() {},
    async edit(callback: (builder: any) => void) {
      const ops: { start: number; end: number; text: string }[] = [];
      callback({
        insert: (pos: vscode.Position, t: string) =>
          ops.push({ start: offsetAt(pos), end: offsetAt(pos), text: t }),
        delete: (range: vscode.Range) =>
          ops.push({
            start: offsetAt(range.start),
            end: offsetAt(range.end),
            text: "",
          }),
        replace: (range: vscode.Range, t: string) =>
          ops.push({
            start: offsetAt(range.start),
            end: offsetAt(range.end),
            text: t,
          }),
      });
      ops.sort((a, b) => b.start - a.start);
      for (const op of ops) {
        text = text.slice(0, op.start) + op.text + text.slice(op.end);
      }
      return true;
    },
  };
  return { editor, getText: () => text };
}

async function* toStream(lines: string[]) {
  for (const line of lines) yield line;
}

async function runApply(
  original: string,
  output: string,
  startLine = 0,
  endLine = original.split("\n").length - 1,
) {
  const { editor, getText } = createEditor(original);
  (vscode.window as any).activeTextEditor = editor;
  (vscode.window as any).visibleTextEditors = [editor];
  const codeLens = new Map();
  const handler = new VerticalDiffHandler(
    startLine,
    endLine,
    editor,
    codeLens,
    () => {},
    () => {},
    { onStatusUpdate: () => {} },
  );
  // Same transforms as core's streamDiffLines for a whole-file apply
  const oldLines = original.split("\n").slice(startLine, endLine + 1);
  const diff = filterLeadingAndTrailingNewLineInsertion(
    streamDiff(oldLines, toStream(output.split("\n"))),
  );
  await handler.run(diff);
  return { handler, getText };
}

const ORIGINAL = `name: sandbox-config
version: 1.0.0
schema: v1
models:
  - name: Gemini 3.1 Pro
    provider: openai
    model: gemini-3.1-pro
    apiBase: http://127.0.0.1:8091/v1
    apiKey: \${{ secrets.KEY }}
    roles:
      - chat
  - name: Gemini 3.8 Flash
    provider: openai
    model: gemini-3.8-flash
    apiBase: http://127.0.0.1:8091/v1
    roles:
      - chat
`;

// What the Gemini apply model produced in the end-to-end run
const GEMINI_OUTPUT =
  "# NextCLI Operator Runbook\n# 1. Run `nextcli status`.\n# 2. Run `nextcli run`.\n" +
  ORIGINAL.replaceAll(
    "apiBase: http://127.0.0.1:8091/v1",
    "apiBase: [http://127.0.0.1:8091/v1](http://127.0.0.1:8091/v1)",
  );

const PROSE =
  "The user wants me to apply an edit.\nCould you clarify what you intend?\n";

describe("VerticalDiffHandler reject restores the file exactly", () => {
  it("after a partial rewrite (the Gemini run)", async () => {
    const { handler, getText } = await runApply(ORIGINAL, GEMINI_OUTPUT);
    await handler.clear(false);
    expect(getText()).toBe(ORIGINAL);
  });

  it("after the whole file was replaced with prose (the incident)", async () => {
    const { handler, getText } = await runApply(ORIGINAL, PROSE);
    await handler.clear(false);
    expect(getText()).toBe(ORIGINAL);
  });

  it("for a range in the middle of the file", async () => {
    // Rewrite lines 4-6 (the first model's name/provider/model)
    const { handler, getText } = await runApply(
      ORIGINAL,
      "  - name: Renamed\nprose instead of yaml",
      4,
      6,
    );
    await handler.clear(false);
    expect(getText()).toBe(ORIGINAL);
  });

  it("for a file without a trailing newline", async () => {
    const original = ORIGINAL.trimEnd();
    const { handler, getText } = await runApply(original, PROSE);
    await handler.clear(false);
    expect(getText()).toBe(original);
  });
});

describe("VerticalDiffHandler accept", () => {
  it("keeps the trailing newline after a prose rewrite", async () => {
    const { handler, getText } = await runApply(ORIGINAL, PROSE);
    await handler.clear(true);
    expect(getText()).toBe(PROSE);
  });

  it("accept produces the model output", async () => {
    const { handler, getText } = await runApply(ORIGINAL, GEMINI_OUTPUT);
    await handler.clear(true);
    expect(getText()).toBe(GEMINI_OUTPUT);
  });
});
