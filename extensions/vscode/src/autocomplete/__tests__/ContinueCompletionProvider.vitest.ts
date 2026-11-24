import { EditAggregator } from "core/nextEdit/context/aggregateEdits";
import * as NextEditLoggingServiceModule from "core/nextEdit/NextEditLoggingService";
import * as PrefetchQueueModule from "core/nextEdit/NextEditPrefetchQueue";
import * as NextEditProviderModule from "core/nextEdit/NextEditProvider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import * as JumpManagerModule from "../../activation/JumpManager";
import {
  getPreEditContent,
  stopEditTracking,
  trackDocumentEdit,
} from "../../util/editLoggingUtils";
import { ContinueCompletionProvider } from "../completionProvider";

import type { Core } from "core/core";

type MockNextEditProvider = ReturnType<typeof createMockNextEditProvider>;
type MockPrefetchQueue = ReturnType<typeof createMockPrefetchQueue>;
type MockJumpManager = ReturnType<typeof createMockJumpManager>;

const mockOutcome = {
  completion: "suggested change",
  diffLines: [],
  editableRegionStartLine: 0,
  editableRegionEndLine: 0,
} as any;

let mockNextEditProvider: MockNextEditProvider;
let mockPrefetchQueue: MockPrefetchQueue;
let mockJumpManager: MockJumpManager;

beforeEach(() => {
  vi.clearAllMocks();

  mockNextEditProvider = createMockNextEditProvider();
  (NextEditProviderModule as any).__setMockNextEditProviderInstance(
    mockNextEditProvider,
  );

  mockPrefetchQueue = createMockPrefetchQueue();
  (PrefetchQueueModule as any).__setMockPrefetchQueueInstance(
    mockPrefetchQueue,
  );

  mockJumpManager = createMockJumpManager();
  (JumpManagerModule as any).__setMockJumpManagerInstance(mockJumpManager);

  const mockLoggingService = createMockLoggingService();
  (NextEditLoggingServiceModule as any).__setMockNextEditLoggingServiceInstance(
    mockLoggingService,
  );

  (vscode.window as any).activeTextEditor = null;
});

describe("ContinueCompletionProvider triggering logic", () => {
  it("starts a new chain when none exists", async () => {
    const document = createDocument();
    setActiveEditor(document);

    const provider = buildProvider();

    await provider.provideInlineCompletionItems(
      document,
      createPosition(),
      createContext(),
      createToken(),
    );

    expect(mockNextEditProvider.startChain).toHaveBeenCalledTimes(1);
    expect(
      mockNextEditProvider.provideInlineCompletionItems,
    ).toHaveBeenCalledTimes(1);
    expect(mockNextEditProvider.deleteChain).not.toHaveBeenCalled();
  });

  it("clears an empty chain once in full file diff mode", async () => {
    const document = createDocument();
    setActiveEditor(document);

    mockNextEditProvider.chainExists.mockReturnValue(true);
    mockPrefetchQueue.__setProcessed([]);
    mockPrefetchQueue.__setUnprocessed([]);

    const provider = buildProvider();

    await provider.provideInlineCompletionItems(
      document,
      createPosition(),
      createContext(),
      createToken(),
    );

    expect(mockNextEditProvider.deleteChain).toHaveBeenCalledTimes(1);
    expect(mockNextEditProvider.startChain).toHaveBeenCalledTimes(1);
    expect(
      mockNextEditProvider.provideInlineCompletionItems,
    ).toHaveBeenCalledTimes(1);
  });

  it("returns null after clearing empty chain when no outcome is available", async () => {
    const document = createDocument();
    setActiveEditor(document);

    mockNextEditProvider.chainExists.mockReturnValue(true);
    mockPrefetchQueue.__setProcessed([]);
    mockPrefetchQueue.__setUnprocessed([]);
    mockNextEditProvider.provideInlineCompletionItems.mockResolvedValueOnce(
      undefined,
    );

    const provider = buildProvider();

    const result = await provider.provideInlineCompletionItems(
      document,
      createPosition(),
      createContext(),
      createToken(),
    );

    expect(result).toBeNull();
    expect(mockNextEditProvider.deleteChain).toHaveBeenCalledTimes(1);
    expect(mockNextEditProvider.startChain).toHaveBeenCalledTimes(1);
    expect(
      mockNextEditProvider.provideInlineCompletionItems,
    ).toHaveBeenCalledTimes(1);
  });

  it("uses queued outcomes when processed items exist", async () => {
    const document = createDocument();
    setActiveEditor(document);

    mockNextEditProvider.chainExists.mockReturnValue(true);
    mockPrefetchQueue.__setProcessed([
      {
        location: {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
        },
        outcome: mockOutcome,
      },
    ]);
    mockJumpManager.suggestJump.mockResolvedValue(true);

    const provider = buildProvider();

    await provider.provideInlineCompletionItems(
      document,
      createPosition(),
      createContext(),
      createToken(),
    );

    expect(mockPrefetchQueue.dequeueProcessed).toHaveBeenCalledTimes(1);
    expect(mockJumpManager.setCompletionAfterJump).toHaveBeenCalledTimes(1);
    expect(mockNextEditProvider.startChain).not.toHaveBeenCalled();
    expect(mockNextEditProvider.deleteChain).not.toHaveBeenCalled();
    expect(
      mockNextEditProvider.provideInlineCompletionItems,
    ).not.toHaveBeenCalled();
  });
});

describe("ContinueCompletionProvider in autocomplete mode", () => {
  const autocompleteOutcome = { completion: "false;" } as any;

  function buildAutocompleteProvider() {
    const provider = buildProvider({
      nextEdit: false,
      usingFullFileDiff: false,
    });
    const completionProvider = (provider as any).completionProvider;
    completionProvider.provideInlineCompletionItems.mockResolvedValue(
      autocompleteOutcome,
    );
    return { provider, completionProvider };
  }

  it("does not start a next edit chain", async () => {
    const document = createDocument();
    const position = createPosition(1, 9);
    setActiveEditor(document, position);

    const { provider, completionProvider } = buildAutocompleteProvider();

    const result = await provider.provideInlineCompletionItems(
      document,
      position,
      createContext(),
      createToken(),
    );

    expect(result).toHaveLength(1);
    expect(mockNextEditProvider.startChain).not.toHaveBeenCalled();
    expect(
      completionProvider.provideInlineCompletionItems,
    ).toHaveBeenCalledTimes(1);
  });

  it("returns a completion for each consecutive request", async () => {
    // Keep chain state like the real NextEditProvider does.
    let chain = false;
    mockNextEditProvider.chainExists.mockImplementation(() => chain);
    mockNextEditProvider.startChain.mockImplementation(() => {
      chain = true;
    });
    mockNextEditProvider.deleteChain.mockImplementation(async () => {
      chain = false;
    });

    const document = createDocument();
    const position = createPosition(1, 9);
    setActiveEditor(document, position);

    const { provider, completionProvider } = buildAutocompleteProvider();

    for (let i = 0; i < 2; i++) {
      const result = await provider.provideInlineCompletionItems(
        document,
        position,
        createContext(),
        createToken(),
      );
      expect(result).toHaveLength(1);
    }
    expect(
      completionProvider.provideInlineCompletionItems,
    ).toHaveBeenCalledTimes(2);
  });

  it("ignores a chain left over from next edit", async () => {
    mockNextEditProvider.chainExists.mockReturnValue(true);

    const document = createDocument();
    const position = createPosition(1, 9);
    setActiveEditor(document, position);

    const { provider, completionProvider } = buildAutocompleteProvider();

    const result = await provider.provideInlineCompletionItems(
      document,
      position,
      createContext(),
      createToken(),
    );

    expect(result).toHaveLength(1);
    expect(mockNextEditProvider.deleteChain).not.toHaveBeenCalled();
    expect(mockPrefetchQueue.dequeueProcessed).not.toHaveBeenCalled();
    expect(
      completionProvider.provideInlineCompletionItems,
    ).toHaveBeenCalledTimes(1);
  });
});

// Edit tracking (files/smallEdit, the pre-edit cache, core's edit clusters)
// follows the provider's Next Edit state
describe("ContinueCompletionProvider Next Edit state and edit tracking", () => {
  const uri = "file:///workspace/a.ts";
  let core: { invoke: ReturnType<typeof vi.fn> };
  let configHandler: { loadConfig: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    stopEditTracking();
    core = { invoke: vi.fn() };
    configHandler = { loadConfig: vi.fn() };
    (vscode.workspace as any).textDocuments = [];
    (vscode.window as any).activeTextEditor = {
      selection: { active: { line: 0, character: 11 } },
    };
  });

  // The onDidChangeTextDocument path in VsCodeExtension
  const track = (
    provider: ContinueCompletionProvider,
    document: vscode.TextDocument,
  ) =>
    trackDocumentEdit(
      editEvent(document),
      configHandler as any,
      {} as any,
      provider,
      vi.fn(async () => []),
      core as unknown as Core,
    );

  const sentEdit = (call = 0) => core.invoke.mock.calls[call][1].actions[0];

  // What core's files/smallEdit handler does with a sent edit
  const coreReceives = (call = 0) =>
    EditAggregator.getInstance().processEdits(
      core.invoke.mock.calls[call][1].actions,
    );

  it("inactive: sends nothing, copies no document text and loads no config", async () => {
    const provider = buildProvider({ nextEdit: false });
    const document = textDocument(uri, "let a = 1;x");
    const getText = vi.spyOn(document, "getText");

    await track(provider, document);

    expect(core.invoke).not.toHaveBeenCalled();
    expect(getText).not.toHaveBeenCalled();
    expect(configHandler.loadConfig).not.toHaveBeenCalled();
    expect(getPreEditContent(document)).toBe("");
  });

  it("turning on snapshots the open documents as the next edit's pre-edit content", async () => {
    (vscode.workspace as any).textDocuments = [textDocument(uri, "let a = 1;")];
    const provider = buildProvider();

    await track(provider, textDocument(uri, "let a = 1;x"));

    expect(core.invoke).toHaveBeenCalledTimes(1);
    expect(core.invoke.mock.calls[0][0]).toBe("files/smallEdit");
    expect(sentEdit().fileContentsBefore).toBe("let a = 1;");
    expect(sentEdit().fileContents).toBe("let a = 1;x");
  });

  it("a config reload while on keeps the pre-edit snapshot", async () => {
    let text = "let a = 1;";
    const document = textDocument(uri, () => text);
    (vscode.workspace as any).textDocuments = [document];
    const provider = buildProvider();

    // The buffer has the keystroke, its change event isn't handled yet
    text = "let a = 1;x";
    provider.activateNextEdit(); // onConfigUpdate -> updateNextEditState
    await track(provider, document);

    expect(sentEdit().fileContentsBefore).toBe("let a = 1;");
  });

  it("turning off drops the open edit cluster, so the next session's diff leaves out the typing done while off", async () => {
    (vscode.workspace as any).textDocuments = [textDocument(uri, "let a = 1;")];
    const provider = buildProvider();
    await track(provider, textDocument(uri, "let a = 1;x"));
    await coreReceives(0);
    expect(EditAggregator.getInstance().getActiveClusterCount()).toBe(1);

    provider.deactivateNextEdit();
    expect(EditAggregator.getInstance().getActiveClusterCount()).toBe(0);

    // Typed while off, then the next edit on the same line once back on
    const gap = "let a = 1;x\nlet b = 2;";
    (vscode.workspace as any).textDocuments = [textDocument(uri, gap)];
    provider.activateNextEdit();
    await track(provider, textDocument(uri, "let a = 1;xy\nlet b = 2;"));
    await coreReceives(1);

    const diff = EditAggregator.getInstance().getInProgressDiff(uri);
    expect(diff).toContain("+let a = 1;xy");
    expect(diff).not.toContain("+let b = 2;");
  });

  it("turning on drops a cluster from an edit core received as Next Edit turned off", async () => {
    (vscode.workspace as any).textDocuments = [textDocument(uri, "let a = 1;")];
    const provider = buildProvider();
    await track(provider, textDocument(uri, "let a = 1;x"));

    provider.deactivateNextEdit();
    await coreReceives(0); // core handled the edit after the turn-off
    expect(EditAggregator.getInstance().getActiveClusterCount()).toBe(1);

    provider.activateNextEdit();
    expect(EditAggregator.getInstance().getActiveClusterCount()).toBe(0);
  });

  it("an edit in flight when Next Edit turns off is not sent and doesn't refill the cache", async () => {
    (vscode.workspace as any).textDocuments = [textDocument(uri, "let a = 1;")];
    const provider = buildProvider();
    const document = textDocument(uri, "let a = 1;x");

    const inFlight = track(provider, document);
    provider.deactivateNextEdit();
    await inFlight;

    expect(core.invoke).not.toHaveBeenCalled();
    expect(getPreEditContent(document)).toBe("");
  });
});

function textDocument(
  uri: string,
  text: string | (() => string),
): vscode.TextDocument {
  return {
    uri: { toString: () => uri },
    getText: () => (typeof text === "string" ? text : text()),
  } as unknown as vscode.TextDocument;
}

// One keystroke at the end of line 0
function editEvent(
  document: vscode.TextDocument,
): vscode.TextDocumentChangeEvent {
  return {
    document,
    contentChanges: [
      {
        range: {
          start: { line: 0, character: 10 },
          end: { line: 0, character: 10 },
        },
        text: "x",
      },
    ],
  } as unknown as vscode.TextDocumentChangeEvent;
}

function buildProvider(
  options: { usingFullFileDiff?: boolean; nextEdit?: boolean } = {},
) {
  const usingFullFileDiff = options.usingFullFileDiff ?? true;
  const configHandler = {
    loadConfig: vi.fn(async () => ({
      config: { selectedModelByRole: { autocomplete: undefined } },
    })),
  } as any;

  const ide = { ideUtils: {} } as any;
  const webviewProtocol = {} as any;

  const provider = new ContinueCompletionProvider(
    configHandler,
    ide,
    webviewProtocol,
    usingFullFileDiff,
  );
  if (options.nextEdit ?? true) {
    provider.activateNextEdit();
  }
  return provider;
}

function createDocument(
  text = "function example() {\n  return true;\n}",
): vscode.TextDocument {
  const lines = text.split("\n");
  return {
    uri: vscode.Uri.parse("file:///test"),
    isUntitled: false,
    getText: (range?: any) => {
      if (!range) {
        return text;
      }
      const startLine = range.start?.line ?? 0;
      const endLine = range.end?.line ?? startLine;
      const startChar = range.start?.character ?? 0;
      const endChar = range.end?.character ?? lines[endLine]?.length ?? 0;
      if (startLine === endLine) {
        const lineText = lines[startLine] ?? "";
        return lineText.slice(startChar, endChar);
      }
      return text;
    },
    lineAt: (position: any) => {
      const lineNumber =
        typeof position === "number" ? position : position.line;
      const lineText = lines[lineNumber] ?? "";
      const range = new (vscode.Range as any)(
        new (vscode.Position as any)(lineNumber, 0),
        new (vscode.Position as any)(lineNumber, lineText.length),
      );
      return {
        lineNumber,
        text: lineText,
        range,
        rangeIncludingLineBreak: range,
        firstNonWhitespaceCharacterIndex: 0,
        isEmptyOrWhitespace: lineText.trim().length === 0,
      } as unknown as vscode.TextLine;
    },
  } as unknown as vscode.TextDocument;
}

function createContext(): any {
  return {
    triggerKind: (vscode.InlineCompletionTriggerKind as any).Automatic,
    selectedCompletionInfo: undefined,
  };
}

function createPosition(line = 0, character = 0) {
  return new (vscode.Position as any)(line, character);
}

function createToken(): any {
  return {
    isCancellationRequested: false,
    onCancellationRequested: vi.fn(),
  };
}

function setActiveEditor(document: any, cursor = createPosition()) {
  const selection = { active: cursor, anchor: cursor };
  (vscode.window as any).activeTextEditor = {
    document,
    selection,
    selections: [selection],
  };
}

function createMockNextEditProvider() {
  return {
    chainExists: vi.fn(() => false),
    startChain: vi.fn(),
    deleteChain: vi.fn(async () => {}),
    provideInlineCompletionItems: vi.fn(async () => mockOutcome),
    provideInlineCompletionItemsWithChain: vi.fn(async () => mockOutcome),
    markDisplayed: vi.fn(),
    getChainLength: vi.fn(() => 0),
  };
}

function createMockPrefetchQueue() {
  let processedItems: any[] = [];
  let unprocessedItems: any[] = [];

  const queue: any = {
    initialize: vi.fn(),
    process: vi.fn(),
    peekThreeProcessed: vi.fn(),
    dequeueProcessed: vi.fn(() => processedItems.shift()),
    enqueueProcessed: vi.fn((item: any) => {
      processedItems.push(item);
    }),
    __setProcessed(items: any[]) {
      processedItems = [...items];
    },
    __setUnprocessed(items: any[]) {
      unprocessedItems = [...items];
    },
  };

  Object.defineProperty(queue, "processedCount", {
    get: () => processedItems.length,
  });

  Object.defineProperty(queue, "unprocessedCount", {
    get: () => unprocessedItems.length,
  });

  return queue;
}

function createMockJumpManager() {
  return {
    isJumpInProgress: vi.fn(() => false),
    setJumpInProgress: vi.fn(),
    completionAfterJump: undefined,
    clearCompletionAfterJump: vi.fn(),
    setCompletionAfterJump: vi.fn(),
    suggestJump: vi.fn(async () => false),
    wasJumpJustAccepted: vi.fn(() => false),
  };
}

function createMockLoggingService() {
  return {
    trackPendingCompletion: vi.fn(),
    handleAbort: vi.fn(),
    markDisplayed: vi.fn(),
    cancelRejectionTimeout: vi.fn(),
    deleteAbortController: vi.fn(),
    cancel: vi.fn(),
  };
}

vi.mock("vscode", () => {
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  }

  class Range {
    constructor(
      public start: Position,
      public end: Position,
    ) {}
  }

  class InlineCompletionItem {
    public insertText: string;
    public range: Range;
    public command?: any;

    constructor(insertText: string, range: Range, command?: any) {
      this.insertText = insertText;
      this.range = range;
      this.command = command;
    }
  }

  const window = {
    activeTextEditor: null as any,
    showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
  };

  const workspace = {
    notebookDocuments: [] as any[],
    textDocuments: [] as any[],
    getConfiguration: vi.fn(() => ({ get: vi.fn() })),
    getWorkspaceFolder: (uri: any) =>
      String(uri).startsWith("file:///workspace")
        ? { uri: { toString: () => "file:///workspace" } }
        : undefined,
  };

  return {
    window,
    workspace,
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    Position,
    Range,
    InlineCompletionItem,
    InlineCompletionTriggerKind: { Automatic: 0, Invoke: 1 },
    NotebookCellKind: { Markup: 1 },
  };
});

vi.mock("core/autocomplete/CompletionProvider", () => {
  return {
    CompletionProvider: class {
      provideInlineCompletionItems = vi.fn();
      markDisplayed = vi.fn();
    },
  };
});

vi.mock("core/autocomplete/util/processSingleLineCompletion", () => ({
  processSingleLineCompletion: vi.fn((text: string) => ({
    completionText: text,
    range: { start: 0, end: text.length },
  })),
}));

vi.mock("../statusBar", () => {
  const StatusBarStatus = {
    Enabled: "enabled",
    Disabled: "disabled",
  } as const;

  return {
    StatusBarStatus,
    getStatusBarStatus: vi.fn(() => StatusBarStatus.Enabled),
    setupStatusBar: vi.fn(),
    stopStatusBarLoading: vi.fn(),
  };
});

vi.mock("../GhostTextAcceptanceTracker", () => {
  const instance = {
    setExpectedGhostTextAcceptance: vi.fn(),
  };
  return {
    GhostTextAcceptanceTracker: {
      getInstance: () => instance,
    },
  };
});

vi.mock("../lsp", () => ({
  getDefinitionsFromLsp: vi.fn(),
}));

vi.mock("../recentlyEdited", () => ({
  RecentlyEditedTracker: class {
    async getRecentlyEditedRanges() {
      return [];
    }
  },
}));

vi.mock("../RecentlyVisitedRangesService", () => ({
  RecentlyVisitedRangesService: class {
    getSnippets() {
      return [];
    }
  },
}));

vi.mock("../activation/NextEditWindowManager", () => ({
  NextEditWindowManager: {
    isInstantiated: vi.fn(() => false),
    getInstance: vi.fn(),
  },
}));

vi.mock("../../activation/JumpManager", () => {
  let instance: any = null;
  return {
    JumpManager: {
      getInstance: () => instance,
    },
    __setMockJumpManagerInstance(value: any) {
      instance = value;
    },
  };
});

vi.mock("core/nextEdit/NextEditPrefetchQueue", () => {
  let instance: any = null;
  return {
    PrefetchQueue: {
      getInstance: () => instance,
    },
    __setMockPrefetchQueueInstance(value: any) {
      instance = value;
    },
  };
});

vi.mock("core/nextEdit/NextEditProvider", () => {
  let instance: any = null;
  return {
    NextEditProvider: {
      initialize: vi.fn(() => instance),
      getInstance: vi.fn(() => instance),
    },
    __setMockNextEditProviderInstance(value: any) {
      instance = value;
    },
  };
});

vi.mock("core/nextEdit/NextEditLoggingService", () => {
  let instance: any = null;
  return {
    NextEditLoggingService: {
      getInstance: () => instance,
    },
    __setMockNextEditLoggingServiceInstance(value: any) {
      instance = value;
    },
  };
});

vi.mock("core/nextEdit/diff/diff", () => ({
  checkFim: vi.fn(() => ({ isFim: true, fimText: "ghost" })),
}));

vi.mock("../util/errorHandling", () => ({
  handleLLMError: vi.fn(async () => false),
}));
