import { beforeEach, describe, expect, it, vi } from "vitest";

import { GitDiffCache } from "./autocomplete/snippets/gitDiffCache";
import { walkDirCache } from "./indexing/walkDir";
import type { Message } from "./protocol/messenger";

// handleFilesChanged with only the collaborators it touches. The method is
// borrowed onto a stub so the test doesn't construct the whole Core ( messenger,
// config loading, indexing startup).
import { Core } from "./core";

function makeCoreStub({ disableIndexing = false } = {}) {
  const refreshCodebaseIndexFiles = vi.fn(async () => {});
  const invoke = vi.fn();
  const stub = {
    ide: {
      getWorkspaceDirs: vi.fn(async () => ["file:///workspace"]),
      listDir: vi.fn(async () => []),
      showToast: vi.fn(),
    },
    configHandler: {
      currentProfile: undefined,
      loadConfig: vi.fn(async () => ({
        config: { disableIndexing },
      })),
      reloadConfig: vi.fn(async () => {}),
    },
    globalContext: { get: vi.fn(() => false), update: vi.fn() },
    codeBaseIndexer: { refreshCodebaseIndexFiles },
    invoke,
  };
  const handle = (Core.prototype as any).handleFilesChanged.bind(stub);
  return { stub, handle, refreshCodebaseIndexFiles, invoke };
}

describe("handleFilesChanged walk-cache invalidation", () => {
  let invalidate: ReturnType<typeof vi.spyOn>;
  let diffInvalidate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    invalidate = vi.spyOn(walkDirCache, "invalidate");
    diffInvalidate = vi
      .spyOn(
        GitDiffCache.getInstance(async () => []),
        "invalidate",
      )
      .mockImplementation(() => {});
  });

  it("a plain source-file save does not clear the walk cache", async () => {
    const { handle, refreshCodebaseIndexFiles } = makeCoreStub();

    await handle({
      data: { uris: ["file:///workspace/src/a.ts"] },
    } as Message<{ uris?: string[] }>);

    expect(invalidate).not.toHaveBeenCalled();
    // The git diff cache still refreshes, and the file is re-indexed
    expect(diffInvalidate).toHaveBeenCalled();
    expect(refreshCodebaseIndexFiles).toHaveBeenCalledWith([
      "file:///workspace/src/a.ts",
    ]);
  });

  it.each([
    [".gitignore", false],
    [".continueignore", false],
    [".gitignore", true],
    [".continueignore", true],
  ])(
    "a %s save clears the walk cache and forces a re-index (indexing off: %s)",
    async (ignoreFile, disableIndexing) => {
      const { handle, invoke, refreshCodebaseIndexFiles } = makeCoreStub({
        disableIndexing,
      });

      await handle({
        data: { uris: [`file:///workspace/${ignoreFile}`] },
      } as Message<{ uris?: string[] }>);

      // Here, since the re-index handler returns first when indexing is off
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("index/forceReIndex", {
        shouldClearIndexes: true,
      });
      expect(refreshCodebaseIndexFiles).not.toHaveBeenCalled();
    },
  );
});
