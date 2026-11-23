import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextEditProvider } from "../NextEditProvider";
import { EditAggregator } from "./aggregateEdits";
import { processNextEditData } from "./processNextEditData";
import { processSmallEdit } from "./processSmallEdit";

vi.mock("../NextEditProvider", () => {
  const instance = {
    addDiffToContext: vi.fn(),
    addAutocompleteContext: vi.fn(),
  };
  return {
    NextEditProvider: { getInstance: () => instance },
  };
});

vi.mock("./processNextEditData", () => ({
  processNextEditData: vi.fn(async () => {}),
}));

// Pins what Mercury and Instinct need from a finished edit cluster:
// the diff history and the autocomplete context keep flowing.
describe("processSmallEdit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (EditAggregator.getInstance() as any).latestContextData = {
      configHandler: {} as any,
      getDefsFromLspFunction: vi.fn(async () => []),
      recentlyEditedRanges: [],
      recentlyVisitedRanges: [],
      workspaceDir: "file:///workspace",
    };
  });

  it("feeds the edit diff to NextEditProvider and starts processNextEditData", async () => {
    const diff = {
      filePath: "file:///workspace/a.ts",
      beforeContent: "let a = 1;",
      afterContent: "let a = 2;",
    };

    await processSmallEdit(
      diff as any,
      { line: 0, character: 0 },
      { line: 0, character: 1 },
      {} as any,
      vi.fn(async () => []),
      {} as any,
    );

    expect(
      NextEditProvider.getInstance().addDiffToContext,
    ).toHaveBeenCalledTimes(1);
    const addedDiff = vi.mocked(NextEditProvider.getInstance().addDiffToContext)
      .mock.calls[0][0];
    expect(addedDiff).toContain("-let a = 1;");
    expect(addedDiff).toContain("+let a = 2;");

    expect(processNextEditData).toHaveBeenCalledTimes(1);
    expect(vi.mocked(processNextEditData).mock.calls[0][0]).toMatchObject({
      filePath: "file:///workspace/a.ts",
      beforeContent: "let a = 1;",
      afterContent: "let a = 2;",
      workspaceDir: "file:///workspace",
    });
  });
});
