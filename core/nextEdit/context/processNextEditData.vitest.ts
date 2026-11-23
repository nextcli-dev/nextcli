import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DataLogger } from "../../data/log";
import { NextEditProvider } from "../NextEditProvider";
import { getAutocompleteContext } from "./autocompleteContextFetching";
import { processNextEditData } from "./processNextEditData";
import { getPrevEditsDescending, prevEditLruCache } from "./prevEditLruCache";

vi.mock("./autocompleteContextFetching", () => ({
  getAutocompleteContext: vi.fn(async () => "rendered context"),
}));

vi.mock("../NextEditProvider", () => {
  const instance = {
    addAutocompleteContext: vi.fn(),
    addDiffToContext: vi.fn(),
  };
  return {
    NextEditProvider: { getInstance: () => instance },
  };
});

const baseParams = () =>
  ({
    filePath: "file:///workspace/a.ts",
    beforeContent: "let a = 1;",
    afterContent: "let a = 2;",
    cursorPosBeforeEdit: { line: 0, character: 0 },
    cursorPosAfterPrevEdit: { line: 0, character: 1 },
    ide: {} as any,
    configHandler: {} as any,
    getDefinitionsFromLsp: vi.fn(async () => []),
    recentlyEditedRanges: [],
    recentlyVisitedRanges: [],
    workspaceDir: "file:///workspace",
  }) as Parameters<typeof processNextEditData>[0];

describe("processNextEditData", () => {
  let logDevData: MockInstance<DataLogger["logDevData"]>;

  beforeEach(() => {
    vi.clearAllMocks();
    prevEditLruCache.clear();
    delete process.env.NEXTCLI_TRACE;
    logDevData = vi
      .spyOn(DataLogger.getInstance(), "logDevData")
      .mockResolvedValue();
  });

  afterEach(() => {
    delete process.env.NEXTCLI_TRACE;
    prevEditLruCache.clear();
    logDevData.mockRestore();
  });

  it("still feeds Instinct's autocomplete context with tracing off", async () => {
    await processNextEditData(baseParams());

    expect(getAutocompleteContext).toHaveBeenCalledTimes(1);
    expect(
      NextEditProvider.getInstance().addAutocompleteContext,
    ).toHaveBeenCalledWith("rendered context");
  });

  it("writes no nextEditWithHistory line and keeps no prev-edit history when unset", async () => {
    await processNextEditData(baseParams());
    await processNextEditData({
      ...baseParams(),
      afterContent: "let a = 3;",
    });

    expect(logDevData).not.toHaveBeenCalled();
    expect(getPrevEditsDescending()).toHaveLength(0);
  });

  it("logs nextEditWithHistory with previous edits when basic", async () => {
    process.env.NEXTCLI_TRACE = "basic";

    await processNextEditData(baseParams());
    expect(logDevData).not.toHaveBeenCalled(); // first edit: no history yet
    expect(getPrevEditsDescending()).toHaveLength(1);

    await processNextEditData({
      ...baseParams(),
      beforeContent: "let a = 2;",
      afterContent: "let a = 3;",
    });

    expect(logDevData).toHaveBeenCalledTimes(1);
    const event = logDevData.mock.calls[0][0] as any;
    expect(event.name).toBe("nextEditWithHistory");
    expect(event.data.previousEdits).toHaveLength(1);
    expect(getPrevEditsDescending()).toHaveLength(2);
  });

  it("logs with full as well", async () => {
    process.env.NEXTCLI_TRACE = "full";

    await processNextEditData(baseParams());
    await processNextEditData({
      ...baseParams(),
      beforeContent: "let a = 2;",
      afterContent: "let a = 3;",
    });

    expect(logDevData).toHaveBeenCalledTimes(1);
  });

  it("an unknown level keeps logging and history off", async () => {
    process.env.NEXTCLI_TRACE = "loud";

    await processNextEditData(baseParams());
    await processNextEditData({
      ...baseParams(),
      afterContent: "let a = 3;",
    });

    expect(logDevData).not.toHaveBeenCalled();
    expect(getPrevEditsDescending()).toHaveLength(0);
  });
});
