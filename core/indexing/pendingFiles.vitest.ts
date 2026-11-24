import fs from "fs";
import os from "os";
import path from "path";

import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testConfigHandler, testIde } from "../test/fixtures.js";
import { localPathToUri } from "../util/pathToUri.js";
import { CodebaseIndexer } from "./CodebaseIndexer.js";

/** A promise that resolves when `open` is called */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

// A save during a running refresh used to be dropped: refreshCodebaseIndexFiles
// returned at once when another refresh held the controller. These pin the
// pending-file queue: the URIs are processed when the running refresh ends.
describe("CodebaseIndexer pending files", () => {
  let indexer: CodebaseIndexer;
  let refreshFile: MockInstance<CodebaseIndexer["refreshFile"]>;
  let lockModule: typeof import("./refreshIndex.js");
  // A real folder: draining re-checks the ignore files in it
  let workspaceDir: string;
  let workspace: string;
  const uri = (name: string) => `${workspace}/${name}`;
  const callsFor = (name: string) =>
    refreshFile.mock.calls.filter(([file]) => file === uri(name));

  /** Holds refreshCodebaseIndex in refreshDirs until the gate opens */
  function holdFullRefresh() {
    const full = gate();
    vi.spyOn(indexer as any, "refreshDirs").mockImplementation(
      async function* () {
        await full.opened;
        yield { status: "done", progress: 1, desc: "done" };
      },
    );
    return full;
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-files-"));
    workspace = localPathToUri(workspaceDir);
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
    vi.spyOn(testIde, "getWorkspaceDirs").mockResolvedValue([workspace]);
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("indexes a file saved during a file refresh once it ends", async () => {
    const a = gate();
    refreshFile.mockImplementation(async (file) => {
      if (file === uri("a.ts")) {
        await a.opened;
      }
    });

    const first = indexer.refreshCodebaseIndexFiles([uri("a.ts")]);
    // The second save arrives while the first refresh is running
    await indexer.refreshCodebaseIndexFiles([uri("b.ts")]);

    a.open();
    await first;

    expect(callsFor("b.ts")).toHaveLength(1);
  });

  it("indexes a file saved during a full directory refresh once it ends", async () => {
    const full = holdFullRefresh();

    const refresh = indexer.refreshCodebaseIndex([workspace]);
    await indexer.refreshCodebaseIndexFiles([uri("b.ts")]);
    expect(refreshFile).not.toHaveBeenCalled();

    full.open();
    await refresh;

    expect(callsFor("b.ts")).toHaveLength(1);
  });

  it("deduplicates repeated saves of the same file", async () => {
    const a = gate();
    refreshFile.mockImplementation(async () => {
      await a.opened;
    });

    const first = indexer.refreshCodebaseIndexFiles([uri("a.ts")]);
    await indexer.refreshCodebaseIndexFiles([uri("b.ts")]);
    await indexer.refreshCodebaseIndexFiles([uri("b.ts")]);

    a.open();
    await first;

    expect(callsFor("b.ts")).toHaveLength(1);
  });

  it("processes files normally when no refresh is running", async () => {
    await indexer.refreshCodebaseIndexFiles([uri("a.ts")]);

    expect(callsFor("a.ts")).toHaveLength(1);
  });

  // The drain used to call refreshCodebaseIndexFiles in a loop; with a full
  // refresh holding the controller each call only queued the file again, so
  // the loop spun on microtasks and the full refresh never got to finish
  it("leaves the queue to a full refresh that starts while it drains", async () => {
    const a = gate();
    const b = gate();
    const bIndexing = gate();
    refreshFile.mockImplementation(async (file) => {
      if (file === uri("a.ts")) {
        await a.opened;
      }
      if (file === uri("b.ts")) {
        bIndexing.open();
        await b.opened;
      }
    });
    const full = holdFullRefresh();
    // A spinning drain blocks the event loop, so no test timeout would fire
    const refreshFiles = indexer.refreshCodebaseIndexFiles.bind(indexer);
    let fileRefreshes = 0;
    vi.spyOn(indexer, "refreshCodebaseIndexFiles").mockImplementation(
      (files) => {
        if (++fileRefreshes > 20) {
          throw new Error("the pending-file drain is spinning");
        }
        return refreshFiles(files);
      },
    );

    const first = indexer.refreshCodebaseIndexFiles([uri("a.ts")]);
    await indexer.refreshCodebaseIndexFiles([uri("b.ts")]);
    a.open();
    // The drain is indexing b.ts: c.ts is saved, then a full refresh starts
    await bIndexing.opened;
    await indexer.refreshCodebaseIndexFiles([uri("c.ts")]);
    const refresh = indexer.refreshCodebaseIndex([workspace]);
    b.open();
    await first;
    expect(callsFor("c.ts")).toHaveLength(0);

    full.open();
    await refresh;
    expect(callsFor("c.ts")).toHaveLength(1);

    // The controller is free again: the next save is indexed at once
    await indexer.refreshCodebaseIndexFiles([uri("d.ts")]);
    expect(callsFor("d.ts")).toHaveLength(1);
  });

  it("skips a queued file that an ignore file excludes by the time it drains", async () => {
    const full = holdFullRefresh();

    const refresh = indexer.refreshCodebaseIndex([workspace]);
    await indexer.refreshCodebaseIndexFiles([
      uri("notes.local.md"),
      uri("b.ts"),
    ]);
    // Saved while the files wait: the re-index it starts skips the note
    fs.writeFileSync(path.join(workspaceDir, ".gitignore"), "notes.local.md\n");
    full.open();
    await refresh;

    expect(callsFor("notes.local.md")).toHaveLength(0);
    expect(callsFor("b.ts")).toHaveLength(1);
  });

  it("frees the controller and drains the queue when the index lock fails", async () => {
    const lockFails = gate();
    vi.spyOn(lockModule.IndexLock, "lock").mockImplementation(async () => {
      await lockFails.opened;
      throw new Error("database disk image is malformed");
    });

    const refresh = indexer.refreshCodebaseIndex([workspace]);
    await indexer.refreshCodebaseIndexFiles([uri("b.ts")]);
    expect(refreshFile).not.toHaveBeenCalled();

    lockFails.open();
    await refresh;
    expect(callsFor("b.ts")).toHaveLength(1);

    // A later save is indexed at once, not queued behind the failed refresh
    await indexer.refreshCodebaseIndexFiles([uri("c.ts")]);
    expect(callsFor("c.ts")).toHaveLength(1);
  });
});
