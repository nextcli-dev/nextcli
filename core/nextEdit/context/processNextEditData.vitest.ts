import fs from "fs";

import { fetchwithRequestOptions } from "@nextcli/fetch";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Core } from "../../core";
import { DataLogger, LOCAL_DEV_DATA_VERSION } from "../../data/log";
import { getDevDataFilePath } from "../../util/paths";
import { NextEditProvider } from "../NextEditProvider";
import { getAutocompleteContext } from "./autocompleteContextFetching";
import { processNextEditData } from "./processNextEditData";
import { prevEditLruCache } from "./prevEditLruCache";

vi.mock("@nextcli/fetch");

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

const DESTINATION = "https://example.com/next-edit";

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
  const dataLogger = DataLogger.getInstance();
  let savedCore: Core | undefined;
  let logDevData: MockInstance<DataLogger["logDevData"]>;

  beforeEach(() => {
    vi.clearAllMocks();
    prevEditLruCache.clear();
    delete process.env.NEXTCLI_TRACE;
    savedCore = dataLogger.core;
    // A data destination with the default level (all) and event list
    dataLogger.core = {
      configHandler: {
        loadConfig: vi.fn().mockResolvedValue({
          config: {
            data: [
              { destination: DESTINATION, schema: LOCAL_DEV_DATA_VERSION },
            ],
          },
        }),
      },
    } as unknown as Core;
    vi.mocked(fetchwithRequestOptions).mockResolvedValue({
      ok: true,
    } as Awaited<ReturnType<typeof fetchwithRequestOptions>>);
    // Calls through: the test awaits the promise processNextEditData drops
    logDevData = vi.spyOn(dataLogger, "logDevData");
  });

  afterEach(() => {
    logDevData.mockRestore();
    dataLogger.core = savedCore;
    prevEditLruCache.clear();
  });

  it("feeds the autocomplete context Instinct's prompt reads", async () => {
    await processNextEditData(baseParams());

    expect(getAutocompleteContext).toHaveBeenCalledTimes(1);
    expect(
      NextEditProvider.getInstance().addAutocompleteContext,
    ).toHaveBeenCalledWith("rendered context");
  });

  // NEXTCLI_TRACE gates only the local file (#216), not configured destinations
  it("sends nextEditWithHistory to a configured destination with NEXTCLI_TRACE unset", async () => {
    await processNextEditData(baseParams());
    await processNextEditData({
      ...baseParams(),
      beforeContent: "let a = 2;",
      afterContent: "let a = 3;",
    });

    expect(logDevData).toHaveBeenCalledTimes(1);
    await logDevData.mock.results[0].value;

    expect(fetchwithRequestOptions).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchwithRequestOptions).mock.calls[0];
    expect(String(url)).toBe(DESTINATION);
    const body = JSON.parse(String(init?.body));
    expect(body.name).toBe("nextEditWithHistory");
    expect(body.data.previousEdits).toHaveLength(1);
    expect(body.data.beforeContent).toBe("let a = 2;");
    expect(
      fs.existsSync(
        getDevDataFilePath("nextEditWithHistory", LOCAL_DEV_DATA_VERSION),
      ),
    ).toBe(false);
  });
});
