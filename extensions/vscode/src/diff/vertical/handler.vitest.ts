import { beforeEach, describe, expect, it, vi } from "vitest";

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
  const documentListeners = new Set<(event: any) => void>();
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
      onDidChangeTextDocument: (listener: (event: any) => void) => {
        documentListeners.add(listener);
        return { dispose: () => documentListeners.delete(listener) };
      },
      fireDocumentChange: (event: any) =>
        documentListeners.forEach((listener) => listener(event)),
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
import { myersDiff } from "core/diff/myers";
import { generateLines } from "core/diff/util";
import { executeFindAndReplace } from "core/edit/searchAndReplace/performReplace";
import { VerticalDiffHandler } from "./handler";

/** An editor backed by a string, applying edits like VS Code does. Like a
  VS Code document, it has one line ending: line text excludes it, and
  inserted text is converted to it. */
function createEditor(initial: string, eol: "\n" | "\r\n" = "\n") {
  let text = initial;
  const lines = () => text.split(eol);
  const offsetAt = (pos: vscode.Position) => {
    const ls = lines();
    if (pos.line >= ls.length) return text.length;
    let offset = 0;
    for (let i = 0; i < pos.line; i++) offset += ls[i].length + eol.length;
    return offset + Math.min(pos.character, ls[pos.line].length);
  };
  const positionAt = (offset: number) => {
    const before = text.slice(0, offset).split(eol);
    return new vscode.Position(
      before.length - 1,
      before[before.length - 1].length,
    );
  };
  /** Applies edits and, like VS Code, reports them before edit() resolves */
  const applyOps = (ops: { start: number; end: number; text: string }[]) => {
    const contentChanges = [];
    ops.sort((a, b) => b.start - a.start);
    for (const op of ops) {
      contentChanges.push({
        range: new vscode.Range(positionAt(op.start), positionAt(op.end)),
        text: op.text,
      });
      const inserted = op.text.replace(/\r\n|\r|\n/g, eol);
      text = text.slice(0, op.start) + inserted + text.slice(op.end);
    }
    if (contentChanges.length) {
      (vscode.workspace as any).fireDocumentChange({
        document,
        contentChanges,
      });
    }
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
    /** Refuse this many upcoming edits, as VS Code does for a stale version */
    refuseEdits: 0,
    async edit(callback: (builder: any) => void) {
      if (editor.refuseEdits > 0) {
        editor.refuseEdits--;
        return false;
      }
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
      applyOps(ops);
      return true;
    },
  };
  /** A keystroke from the user, not from the handler */
  const userInsert = (pos: vscode.Position, t: string) =>
    applyOps([{ start: offsetAt(pos), end: offsetAt(pos), text: t }]);
  /** A user selection replaced (or deleted, with "") */
  const userReplace = (from: vscode.Position, to: vscode.Position, t: string) =>
    applyOps([{ start: offsetAt(from), end: offsetAt(to), text: t }]);
  return { editor, getText: () => text, userInsert, userReplace };
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

/** Streams `output`, pausing after `pauseAfter` lines until resumed */
function pausingStream(output: string, pauseAfter: number) {
  let resume!: () => void;
  const resumed = new Promise<void>((r) => (resume = r));
  let reachedPause!: () => void;
  const paused = new Promise<void>((r) => (reachedPause = r));
  async function* lines() {
    const all = output.split("\n");
    for (let i = 0; i < all.length; i++) {
      if (i === pauseAfter) {
        reachedPause();
        await resumed;
      }
      yield all[i];
    }
  }
  return { lines: lines(), paused, resume };
}

async function startApplyAndPause(
  original: string,
  output: string,
  pauseAfter: number,
) {
  const { editor, getText, userInsert, userReplace } = createEditor(original);
  (vscode.window as any).activeTextEditor = editor;
  (vscode.window as any).visibleTextEditors = [editor];
  const statusUpdates: any[][] = [];
  const clearCalls: any[][] = [];
  let clearDone: Promise<void> | undefined;
  const handler: VerticalDiffHandler = new VerticalDiffHandler(
    0,
    original.split("\n").length - 1,
    editor,
    new Map(),
    (...args: any[]) => {
      clearCalls.push(args);
      // After a user edit the handler reverts and closes itself
      if (!args[2]?.handlerAlreadyCleared) {
        clearDone = handler.clear(args[1]);
      }
    },
    () => {},
    { onStatusUpdate: (...args: any[]) => statusUpdates.push(args) },
  );
  const stream = pausingStream(output, pauseAfter);
  const diff = filterLeadingAndTrailingNewLineInsertion(
    streamDiff(original.split("\n"), stream.lines),
  );
  const run = handler.run(diff);
  await stream.paused;
  // Let the lines before the pause reach the document
  await new Promise((r) => setTimeout(r, 0));
  const finish = async () => {
    stream.resume();
    await run;
    await clearDone;
  };
  return {
    editor,
    handler,
    getText,
    userInsert,
    userReplace,
    statusUpdates,
    clearCalls,
    finish,
  };
}

describe("VerticalDiffHandler user typing mid-stream", () => {
  it("does not treat its own edits as user edits", async () => {
    const { handler, getText } = await runApply(ORIGINAL, GEMINI_OUTPUT);
    expect(handler.isCancelled).toBe(false);
    await handler.clear(true);
    expect(getText()).toBe(GEMINI_OUTPUT);
  });

  it("stops the stream, reverts the edit and keeps a typed line", async () => {
    const apply = await startApplyAndPause(ORIGINAL, GEMINI_OUTPUT, 6);
    // The streamed header lines are already in the document
    expect(apply.getText()).toContain("# NextCLI Operator Runbook");

    const line = apply.getText().split("\n").indexOf("models:");
    apply.userInsert(new vscode.Position(line, 0), "# ZZZTEST123\n");
    await apply.finish();

    expect(apply.getText()).toBe(
      ORIGINAL.replace("models:", "# ZZZTEST123\nmodels:"),
    );
    expect(apply.clearCalls).toEqual([
      [
        "file:///sandbox/.continue/config.yaml",
        false,
        { focusChatInput: false, handlerAlreadyCleared: true },
      ],
    ]);
    const closed = apply.statusUpdates.find((u) => u[0] === "closed");
    expect(closed?.[4]).toBe(true);
    expect(apply.statusUpdates.some((u) => u[0] === "done")).toBe(false);
  });

  it("restores lines the stream had removed and keeps typed text", async () => {
    const apply = await startApplyAndPause(ORIGINAL, PROSE, 1);
    const lastLine = apply.getText().split("\n").length - 1;
    apply.userInsert(new vscode.Position(lastLine, 0), "ZZZTEST123");
    await apply.finish();

    expect(apply.getText()).toBe(ORIGINAL + "ZZZTEST123");
  });

  // GEMINI_OUTPUT starts with three new header lines: after 6 streamed lines
  // they sit at the top of the document as one multi-line green block
  const HEADER = "# NextCLI Operator Runbook";

  it("keeps a newline and a character typed inside a multi-line green block", async () => {
    const apply = await startApplyAndPause(ORIGINAL, GEMINI_OUTPUT, 6);
    expect(apply.getText().startsWith(HEADER)).toBe(true);

    // Enter in the middle of the block's second line, then a character
    apply.userInsert(new vscode.Position(1, 5), "\n");
    apply.userInsert(new vscode.Position(3, 0), "Q");
    await apply.finish();

    // Both keystrokes kept where the block was; no streamed line left behind
    expect(apply.getText()).toBe("\nQ" + ORIGINAL);
  });

  it("applies a deletion over added and original text to the original part only", async () => {
    const apply = await startApplyAndPause(ORIGINAL, GEMINI_OUTPUT, 6);
    const lines = apply.getText().split("\n");
    const firstOriginal = lines.indexOf("name: sandbox-config");
    expect(firstOriginal).toBeGreaterThan(0);

    // Select from inside the last header line into "name: " and delete it
    apply.userReplace(
      new vscode.Position(firstOriginal - 1, 3),
      new vscode.Position(firstOriginal, "name: ".length),
      "",
    );
    await apply.finish();

    expect(apply.getText()).toBe(ORIGINAL.replace("name: ", ""));
  });

  it("retries the revert when the user types while it is being applied", async () => {
    const apply = await startApplyAndPause(ORIGINAL, GEMINI_OUTPUT, 6);
    apply.editor.refuseEdits = 1;
    apply.userInsert(new vscode.Position(0, 0), "ZZZ");
    await apply.finish();

    expect(apply.getText()).toBe("ZZZ" + ORIGINAL);
  });
});

describe("VerticalDiffHandler user typing during the final Myers pass", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("reverts around the user's text instead of overwriting it", async () => {
    const { editor, getText, userInsert } = createEditor(ORIGINAL);
    (vscode.window as any).activeTextEditor = editor;
    (vscode.window as any).visibleTextEditors = [editor];
    const statusUpdates: any[][] = [];
    const handler: VerticalDiffHandler = new VerticalDiffHandler(
      0,
      ORIGINAL.split("\n").length - 1,
      editor,
      new Map(),
      () => {},
      () => {},
      { onStatusUpdate: (...args: any[]) => statusUpdates.push(args) },
    );
    const diff = filterLeadingAndTrailingNewLineInsertion(
      streamDiff(ORIGINAL.split("\n"), toStream(GEMINI_OUTPUT.split("\n"))),
    );
    const run = handler.run(diff);

    // The stream is done; the final pass waits 100 ms before rewriting
    await vi.waitFor(() => expect((handler as any).phase).toBe("finishing"));
    const last = getText().split("\n").length - 1;
    userInsert(new vscode.Position(last, 0), "TYPED");
    await run;

    expect(getText()).toBe(ORIGINAL + "TYPED");
    expect(statusUpdates.some((u) => u[0] === "done")).toBe(false);
    const closed = statusUpdates.find((u) => u[0] === "closed");
    expect(closed?.[4]).toBe(true);
  });
});

describe("VerticalDiffHandler instant apply on a CRLF file", () => {
  const CRLF_ORIGINAL = ORIGINAL.replace(/\n/g, "\r\n");

  async function instantApply(newContent: string) {
    const { editor, getText } = createEditor(CRLF_ORIGINAL, "\r\n");
    (vscode.window as any).activeTextEditor = editor;
    (vscode.window as any).visibleTextEditors = [editor];
    const handler = new VerticalDiffHandler(
      0,
      editor.document.lineCount - 1,
      editor,
      new Map(),
      () => {},
      () => {},
      { instant: true, onStatusUpdate: () => {} },
    );
    // What ApplyManager.applyToFile does for single_find_and_replace
    await handler.reapplyWithMyersDiff(
      myersDiff(editor.document.getText(), newContent),
    );
    return { handler, getText };
  }

  // The edited file that executeFindAndReplace gives for an LF old_string
  const edited = executeFindAndReplace(
    CRLF_ORIGINAL,
    "    roles:\n      - chat\n  - name: Gemini 3.8 Flash",
    "    roles:\n      - chat\n      - edit\n  - name: Gemini 3.8 Flash",
    false,
  );

  it("accepting gives the edited file with CRLF line endings only", async () => {
    const { handler, getText } = await instantApply(edited);
    await handler.clear(true);

    expect(getText()).toBe(edited);
    expect(getText()).not.toMatch(/[^\r]\n|\r(?!\n)/);
  });

  it("rejecting restores the CRLF file exactly", async () => {
    const { handler, getText } = await instantApply(edited);
    await handler.clear(false);

    expect(getText()).toBe(CRLF_ORIGINAL);
  });
});

describe("VerticalDiffHandler instant lazy apply on a CRLF file", () => {
  // applyCodeBlock diffs on LF text, so the diff lines have no "\r"; the
  // document is CRLF (what ApplyManager.handleExistingDocument streams)
  const CRLF_ORIGINAL = ORIGINAL.replace(/\n/g, "\r\n");
  const EDITED = ORIGINAL.replace(
    "      - chat\n  - name: Gemini 3.8 Flash",
    "      - chat\n      - edit\n  - name: Gemini 3.8 Flash",
  );

  async function streamInstant() {
    const { editor, getText } = createEditor(CRLF_ORIGINAL, "\r\n");
    (vscode.window as any).activeTextEditor = editor;
    (vscode.window as any).visibleTextEditors = [editor];
    const handler = new VerticalDiffHandler(
      0,
      editor.document.lineCount - 1,
      editor,
      new Map(),
      () => {},
      () => {},
      { instant: true, onStatusUpdate: () => {} },
    );
    await handler.run(generateLines(myersDiff(ORIGINAL, EDITED)));
    return { handler, getText };
  }

  it("accepting gives the edited file with CRLF line endings only", async () => {
    const { handler, getText } = await streamInstant();
    await handler.clear(true);

    expect(getText()).toBe(EDITED.replace(/\n/g, "\r\n"));
  });

  it("rejecting restores the CRLF file exactly", async () => {
    const { handler, getText } = await streamInstant();
    await handler.clear(false);

    expect(getText()).toBe(CRLF_ORIGINAL);
  });
});
