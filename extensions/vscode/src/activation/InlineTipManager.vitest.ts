import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { getTheme } from "../util/getTheme";

import { InlineTipManager } from "./InlineTipManager";

vi.mock("vscode", () => ({
  window: {
    createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeTextEditorSelection: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: vi.fn() })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  },
  Uri: { parse: vi.fn(() => ({ toString: () => "mock-uri" })) },
  MarkdownString: class {
    isTrusted = false;
    constructor(public value: string) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
}));

vi.mock("../util/getTheme", () => ({ getTheme: vi.fn() }));

vi.mock("svg-builder", () => {
  const builder = {
    width: vi.fn().mockReturnThis(),
    height: vi.fn().mockReturnThis(),
    text: vi.fn().mockReturnThis(),
    render: vi.fn().mockReturnValue("<svg></svg>"),
  };
  return { default: builder };
});

// #12947: themes without a `colors` key crashed activation
describe("InlineTipManager with unusual themes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (InlineTipManager as any).instance = undefined;
  });

  it.each([
    ["no colors key", { base: "vs-dark" }],
    ["no theme at all", undefined],
    ["empty colors", { base: "vs-dark", colors: {} }],
  ])("creates the tooltip decoration with %s", (_, theme) => {
    vi.mocked(getTheme).mockReturnValue(theme as any);

    expect(() => InlineTipManager.getInstance()).not.toThrow();

    const decorationCalls = vi.mocked(
      vscode.window.createTextEditorDecorationType,
    ).mock.calls;
    expect(
      decorationCalls.some(([options]) =>
        String(options.after?.border).includes("#333333"),
      ),
    ).toBe(true);
  });

  it("uses the theme background when there is one", () => {
    vi.mocked(getTheme).mockReturnValue({
      base: "vs-dark",
      colors: { "editor.background": "#123456" },
    } as any);

    InlineTipManager.getInstance();

    const decorationCalls = vi.mocked(
      vscode.window.createTextEditorDecorationType,
    ).mock.calls;
    expect(
      decorationCalls.some(([options]) =>
        String(options.after?.border).includes("#123456"),
      ),
    ).toBe(true);
  });
});
