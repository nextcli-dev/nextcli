import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { activate } from "./extension";

const outputChannel = { show: vi.fn(), appendLine: vi.fn(), dispose: vi.fn() };

vi.mock("vscode", () => ({
  window: {
    createOutputChannel: vi.fn(() => outputChannel),
    showWarningMessage: vi.fn(),
  },
  commands: {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    executeCommand: vi.fn(),
  },
}));

vi.mock("core/util/ca", () => ({ setupCa: vi.fn() }));
vi.mock("./.buildTimestamp", () => ({ default: 0 }));
vi.mock("./activation/activate", () => ({
  activateExtension: vi.fn(() => Promise.reject(new Error("native module"))),
}));

function makeContext() {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

// #12946: "View Logs" on the activation error did nothing, because the
// command was only registered by the activation that had just failed
describe("activate when activation fails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers continue.viewLogs before activation runs", async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(
      undefined as any,
    );

    const pending = activate(makeContext());
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      "continue.viewLogs",
      expect.any(Function),
    );
    await pending;
  });

  it("writes the error to the output channel and names it in the alert", async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(
      undefined as any,
    );

    await activate(makeContext());

    expect(outputChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("native module"),
    );
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      "Error activating NextCLI: native module",
      "View Logs",
      "Retry",
    );
  });

  it("shows the logs when View Logs is chosen", async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(
      "View Logs" as any,
    );

    await activate(makeContext());
    await new Promise((resolve) => setImmediate(resolve));

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "continue.viewLogs",
    );
    const viewLogs = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.find(([id]) => id === "continue.viewLogs")![1];
    viewLogs();
    expect(outputChannel.show).toHaveBeenCalled();
  });
});

// PR #7 review: the webview uses continue.viewLogs to open DevTools; a healthy
// activation must not open an empty output channel
describe("continue.viewLogs after a successful activation", () => {
  it("toggles DevTools without creating or showing an output channel", async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const { activateExtension } = await import("./activation/activate");
    vi.mocked(activateExtension).mockResolvedValueOnce(undefined as any);
    const { activate: freshActivate } = await import("./extension");

    await freshActivate(makeContext());
    const viewLogs = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.find(([id]) => id === "continue.viewLogs")![1];
    viewLogs();

    expect(vscode.window.createOutputChannel).not.toHaveBeenCalled();
    expect(outputChannel.show).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.toggleDevTools",
    );
  });
});
