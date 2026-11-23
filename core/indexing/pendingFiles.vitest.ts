import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { testConfigHandler, testIde } from "../test/fixtures.js";
import { CodebaseIndexer } from "./CodebaseIndexer.js";

// A save during a running refresh used to be dropped: refreshCodebaseIndexFiles
// returned at once when another refresh held the controller. These pin the
// pending-file queue: the URIs are processed when the running refresh ends.
describe("CodebaseIndexer pending files", () => {
  let indexer: CodebaseIndexer;
  let refreshFile: MockInstance<CodebaseIndexer["refreshFile"]>;
  let lockModule: typeof import("./refreshIndex.js");

  beforeEach(async () => {
    vi.restoreAllMocks();
    indexer = new CodebaseIndexer(testConfigHandler, testIde, undefined, false);
    await indexer.initPromise;

    // No sqlite lock in these unit tests
    lockModule = await import("./refreshIndex.js");
    vi.spyOn(lockModule.IndexLock, "isLocked").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(lockModule.IndexLock, "lock").mockResolvedValue(undefined as any);
    vi.spyOn(lockModule.IndexLock, "unlock").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(lockModule.IndexLock, "updateTimestamp").mockResolvedValue(
      undefined as any,
    );

    refreshFile = vi.spyOn(indexer, "refreshFile").mockResolvedValue();
    vi.spyOn(testIde, "getWorkspaceDirs").mockResolvedValue([
      "file:///workspace",
    ]);
  });

  it("indexes a file saved during a file refresh once it ends", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    refreshFile.mockImplementation(async (file) => {
      if (file === "file:///workspace/a.ts") {
        await gate;
      }
    });

    const first = indexer.refreshCodebaseIndexFiles(["file:///workspace/a.ts"]);
    // The second save arrives while the first refresh is running
    await indexer.refreshCodebaseIndexFiles(["file:///workspace/b.ts"]);

    release();
    await first;

    expect(refreshFile).toHaveBeenCalledWith(
      "file:///workspace/b.ts",
      expect.anything(),
    );
  });

  it("indexes a file saved during a full directory refresh once it ends", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(indexer as any, "refreshDirs").mockImplementation(
      async function* () {
        await gate;
        yield { status: "done", progress: 1, desc: "done" };
      },
    );

    const full = indexer.refreshCodebaseIndex(["file:///workspace"]);
    await indexer.refreshCodebaseIndexFiles(["file:///workspace/b.ts"]);
    expect(refreshFile).not.toHaveBeenCalled();

    release();
    await full;

    expect(refreshFile).toHaveBeenCalledWith(
      "file:///workspace/b.ts",
      expect.anything(),
    );
  });

  it("deduplicates repeated saves of the same file", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    refreshFile.mockImplementation(async () => {
      await gate;
    });

    const first = indexer.refreshCodebaseIndexFiles(["file:///workspace/a.ts"]);
    await indexer.refreshCodebaseIndexFiles(["file:///workspace/b.ts"]);
    await indexer.refreshCodebaseIndexFiles(["file:///workspace/b.ts"]);

    release();
    await first;

    const bCalls = refreshFile.mock.calls.filter(
      ([file]) => file === "file:///workspace/b.ts",
    );
    expect(bCalls).toHaveLength(1);
  });

  it("processes files normally when no refresh is running", async () => {
    await indexer.refreshCodebaseIndexFiles(["file:///workspace/a.ts"]);

    expect(refreshFile).toHaveBeenCalledWith(
      "file:///workspace/a.ts",
      expect.anything(),
    );
  });
});
