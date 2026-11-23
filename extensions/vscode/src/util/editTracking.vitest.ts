import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import {
  clearAllDocumentContentCache,
  getPreEditContent,
  initDocumentContentCache,
  trackDocumentEdit,
} from "./editLoggingUtils";

// Mirrors VsCodeExtension's onDidChangeTextDocument listener: selection
// tracking always runs; edit tracking goes through trackDocumentEdit, which
// gates on the completion provider's runtime Next Edit state.
function makeListener(state: {
  nextEditActive: boolean;
  documentChanged: () => void;
  invoke: (type: string, data: unknown) => void;
}) {
  const completionProvider = {
    get nextEditActive() {
      return state.nextEditActive;
    },
    recentlyEditedTracker: {
      getRecentlyEditedRanges: vi.fn(async () => []),
    },
    recentlyVisitedRanges: { getSnippets: vi.fn(() => []) },
  } as any;

  return async (event: vscode.TextDocumentChangeEvent) => {
    if (event.contentChanges.length > 0) {
      state.documentChanged();
    }

    const editInfo = await trackDocumentEdit(
      event,
      { loadConfig: vi.fn(async () => ({ config: {} })) } as any,
      {} as any,
      completionProvider,
      vi.fn(async () => []),
    );

    if (editInfo) {
      state.invoke("files/smallEdit", editInfo);
    }
  };
}

function makeDocument(uri: string, text: string): vscode.TextDocument {
  return {
    uri: { toString: () => uri },
    getText: () => text,
  } as unknown as vscode.TextDocument;
}

function makeChangeEvent(
  document: vscode.TextDocument,
): vscode.TextDocumentChangeEvent {
  return {
    document,
    contentChanges: [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        text: "x",
      },
    ],
  } as unknown as vscode.TextDocumentChangeEvent;
}

describe("edit tracking gate (Next Edit state)", () => {
  let state: {
    nextEditActive: boolean;
    documentChanged: ReturnType<typeof vi.fn>;
    invoke: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllDocumentContentCache();
    (vscode.window as any).activeTextEditor = {
      selection: { active: { line: 0, character: 1 } },
    };
    state = {
      nextEditActive: false,
      documentChanged: vi.fn(),
      invoke: vi.fn(),
    };
  });

  it("inactive: no files/smallEdit, cache stays empty, selection tracking runs", async () => {
    const document = makeDocument("file:///workspace/a.ts", "let a = 1;");
    const listener = makeListener(state);

    await listener(makeChangeEvent(document));

    expect(state.documentChanged).toHaveBeenCalledTimes(1);
    expect(state.invoke).not.toHaveBeenCalled();
    expect(getPreEditContent(document)).toBe("");
  });

  it("active: the edit reaches files/smallEdit with pre-edit content", async () => {
    state.nextEditActive = true;
    initDocumentContentCache(
      makeDocument("file:///workspace/a.ts", "let a = 1;"),
    );
    const after = makeDocument("file:///workspace/a.ts", "let a = 1;x");
    const listener = makeListener(state);

    await listener(makeChangeEvent(after));

    expect(state.invoke).toHaveBeenCalledTimes(1);
    const [type, editInfo] = state.invoke.mock.calls[0];
    expect(type).toBe("files/smallEdit");
    expect((editInfo as any).actions[0].fileContentsBefore).toBe("let a = 1;");
    expect((editInfo as any).actions[0].fileContents).toBe("let a = 1;x");
  });

  it("deactivation clears the cache; activation refills it from open documents", async () => {
    const document = makeDocument("file:///workspace/a.ts", "content");
    (vscode.workspace as any).__setOpenDocuments([document]);
    initDocumentContentCache(document);
    expect(getPreEditContent(document)).toBe("content");

    clearAllDocumentContentCache();
    expect(getPreEditContent(document)).toBe("");

    // What activateNextEdit does: fill from the open documents
    for (const doc of vscode.workspace.textDocuments) {
      initDocumentContentCache(doc);
    }
    expect(getPreEditContent(document)).toBe("content");
    (vscode.workspace as any).__setOpenDocuments([]);
  });

  it("skips the config load and the document copies while inactive", async () => {
    const loadConfig = vi.fn(async () => ({ config: {} }));
    const document = makeDocument("file:///workspace/a.ts", "text");
    const getText = vi.spyOn(document, "getText");
    const completionProvider = { nextEditActive: false } as any;

    const result = await trackDocumentEdit(
      makeChangeEvent(document),
      { loadConfig } as any,
      {} as any,
      completionProvider,
      vi.fn(async () => []),
    );

    expect(result).toBeUndefined();
    expect(loadConfig).not.toHaveBeenCalled();
    expect(getText).not.toHaveBeenCalled();
  });
});

vi.mock("vscode", () => {
  let openDocuments: any[] = [];
  return {
    window: { activeTextEditor: undefined as any },
    workspace: {
      getWorkspaceFolder: (uri: any) =>
        String(uri).startsWith("file:///workspace")
          ? { uri: { toString: () => "file:///workspace" } }
          : undefined,
      get textDocuments() {
        return openDocuments;
      },
      __setOpenDocuments(docs: any[]) {
        openDocuments = docs;
      },
    },
  };
});
