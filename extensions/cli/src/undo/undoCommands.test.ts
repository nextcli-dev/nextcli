import { describe, expect, it, vi } from "vitest";

import { processSlashCommandResult } from "../ui/hooks/useChat.helpers.js";

vi.mock("../session.js", () => ({
  loadSession: vi.fn(),
  updateSessionHistory: vi.fn(),
  startNewSession: vi.fn(),
}));

describe("/undo and /redo results", () => {
  it("are recognised as slash commands", async () => {
    const { handleSlashCommands } = await import("../slashCommands.js");
    expect(await handleSlashCommands("/undo", {} as any)).toEqual({
      undo: true,
    });
    expect(await handleSlashCommands("/redo", {} as any)).toEqual({
      redo: true,
    });
  });

  it("call the undo and redo handlers and send nothing to the model", () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    const common = {
      chatHistory: [],
      setChatHistory: vi.fn(),
      onShowConfigSelector: vi.fn(),
      onUndo,
      onRedo,
    };

    expect(
      processSlashCommandResult({ ...common, result: { undo: true } }),
    ).toBeNull();
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onRedo).not.toHaveBeenCalled();

    expect(
      processSlashCommandResult({ ...common, result: { redo: true } }),
    ).toBeNull();
    expect(onRedo).toHaveBeenCalledOnce();
  });
});
