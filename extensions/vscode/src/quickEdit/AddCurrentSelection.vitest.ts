import { beforeEach, describe, expect, it, vi } from "vitest";

const FILE_PATH = "/workspace/a.ts";
const FILE_URI = "file:///workspace/a.ts";

// The code under test replaces editor.selection, so each test gets a new one
function newEditor() {
  return {
    document: {
      fileName: FILE_PATH,
      uri: { toString: () => FILE_URI },
      lineAt: () => ({ range: { end: { character: 5 } } }),
    },
    selection: {
      start: {
        line: 0,
        character: 2,
        with: () => ({ line: 0, character: 0 }),
      },
      end: { line: 0, character: 4 },
      anchor: { line: 0, character: 2 },
    } as unknown,
  };
}
let editor = newEditor();

vi.mock("vscode", () => ({
  window: {
    get activeTextEditor() {
      return editor;
    },
  },
  Position: class {
    constructor(
      public line: number,
      public character: number,
    ) {}
  },
  Range: class {
    constructor(
      public start: unknown,
      public end: unknown,
    ) {}
  },
  Selection: class {
    constructor(
      public anchor: unknown,
      public active: unknown,
    ) {}
  },
}));

vi.mock("../util/addCode", () => ({
  getRangeInFileWithContents: vi.fn(() => ({
    filepath: FILE_URI,
    contents: "hello",
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 },
    },
  })),
}));

vi.mock("./EditDecorationManager", () => ({ default: class {} }));
vi.mock("./QuickEditQuickPick", () => ({}));
vi.mock("../diff/vertical/manager", () => ({}));
vi.mock("../webviewProtocol", () => ({}));

import { addCurrentSelectionToEdit } from "./AddCurrentSelection";

function setup(handlersByUri: Record<string, unknown>) {
  const webviewProtocol = { request: vi.fn() };
  const editDecorationManager = {
    clear: vi.fn(),
    addDecorations: vi.fn(),
  };
  const verticalDiffManager = {
    getHandlerForFile: vi.fn((key: string) => handlersByUri[key]),
  };
  const run = () =>
    addCurrentSelectionToEdit({
      webviewProtocol: webviewProtocol as any,
      verticalDiffManager: verticalDiffManager as any,
      args: undefined,
      editDecorationManager: editDecorationManager as any,
    });
  return { webviewProtocol, editDecorationManager, run };
}

describe("addCurrentSelectionToEdit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editor = newEditor();
  });

  it("only refocuses the input when the file already has a diff open", async () => {
    // VerticalDiffManager keys its handlers by URI string
    const { webviewProtocol, editDecorationManager, run } = setup({
      [FILE_URI]: {},
    });

    await run();

    expect(webviewProtocol.request.mock.calls).toEqual([
      ["focusContinueInput", undefined],
    ]);
    expect(editDecorationManager.addDecorations).not.toHaveBeenCalled();
  });

  it("adds the selection to edit when the file has no diff open", async () => {
    const { webviewProtocol, editDecorationManager, run } = setup({});

    await run();

    expect(editDecorationManager.addDecorations).toHaveBeenCalledTimes(1);
    expect(webviewProtocol.request).toHaveBeenCalledWith(
      "setCodeToEdit",
      expect.objectContaining({ filepath: FILE_URI }),
    );
    expect(webviewProtocol.request).not.toHaveBeenCalledWith(
      "focusContinueInput",
      undefined,
    );
  });
});
