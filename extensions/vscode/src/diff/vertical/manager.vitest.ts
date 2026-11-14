import { beforeEach, describe, expect, it, vi } from "vitest";

const FILE_URI = "file:///workspace/a.ts";

vi.mock("vscode", () => ({
  window: {
    activeTextEditor: {
      document: { uri: { toString: () => "file:///workspace/a.ts" } },
    },
  },
}));

// The handler's last-but-one argument is the refresh it calls when its
// blocks change
const handlerRefreshes: (() => void)[] = [];
vi.mock("./handler", () => ({
  VerticalDiffHandler: class {
    constructor(...args: unknown[]) {
      handlerRefreshes.push(args[5] as () => void);
    }
    clear() {}
  },
}));

vi.mock("../../extension/EditOutcomeTracker", () => ({
  editOutcomeTracker: {},
}));
vi.mock("../../util/errorHandling", () => ({ handleLLMError: vi.fn() }));
vi.mock("../../apply/utils", () => ({ isFastApplyModel: vi.fn() }));

import { VerticalDiffManager } from "./manager";

describe("VerticalDiffManager.refreshCodeLens", () => {
  beforeEach(() => {
    handlerRefreshes.length = 0;
  });

  it("reaches handlers created before the refresh was assigned or replaced", () => {
    const manager = new VerticalDiffManager({} as any, {} as any, {} as any);
    // A diff can start before the CodeLens providers are registered, while
    // refreshCodeLens is still the initial no-op
    manager.createVerticalDiffHandler(FILE_URI, 0, 1, {} as any);
    expect(handlerRefreshes).toHaveLength(1);

    const first = vi.fn();
    manager.refreshCodeLens = first;
    handlerRefreshes[0]();
    expect(first).toHaveBeenCalledTimes(1);

    const second = vi.fn();
    manager.refreshCodeLens = second;
    handlerRefreshes[0]();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });
});
