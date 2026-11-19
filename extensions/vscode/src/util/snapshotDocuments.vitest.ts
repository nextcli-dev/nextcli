import { beforeEach, describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({
  textDocuments: [] as any[],
  fs: { readFile: vi.fn() },
  applyEdit: vi.fn(async () => true),
}));

vi.mock("vscode", () => {
  class WorkspaceEdit {
    edits: unknown[] = [];
    replace(uri: unknown, range: unknown, text: string) {
      this.edits.push({ uri, range, text });
    }
  }
  class Range {
    constructor(
      readonly start: number,
      readonly end: number,
    ) {}
  }
  const uri = (value: string) => ({ toString: () => value });
  return {
    workspace,
    WorkspaceEdit,
    Range,
    Uri: {
      file: (p: string) => uri(`file://${p}`),
      parse: (p: string) => uri(p),
    },
  };
});

import { syncSnapshotDocuments } from "./snapshotDocuments";

function document(path: string, isDirty: boolean, text = "old") {
  return {
    uri: { toString: () => `file://${path}` },
    isDirty,
    getText: () => text,
    positionAt: (offset: number) => offset,
    save: vi.fn(async () => true),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  workspace.textDocuments = [];
});

describe("syncSnapshotDocuments", () => {
  it("saves the agent's unsaved edits, only in the listed files", async () => {
    const edited = document("/repo/a.ts", true);
    const other = document("/repo/b.ts", true);
    const clean = document("/repo/c.ts", false);
    workspace.textDocuments = [edited, other, clean];

    await syncSnapshotDocuments(["file:///repo/a.ts", "/repo/c.ts"], "save");

    expect(edited.save).toHaveBeenCalledOnce();
    expect(other.save).not.toHaveBeenCalled();
    expect(clean.save).not.toHaveBeenCalled();
  });

  it("puts the restored text into dirty editors after an undo", async () => {
    const dirty = document("/repo/a.ts", true, "undone text");
    workspace.textDocuments = [dirty];
    workspace.fs.readFile.mockResolvedValue(
      new TextEncoder().encode("restored"),
    );

    await syncSnapshotDocuments(["/repo/a.ts"], "reload");

    const [edit] = workspace.applyEdit.mock.calls[0] as unknown as [
      { edits: { text: string }[] },
    ];
    expect(edit.edits[0].text).toBe("restored");
    expect(dirty.save).toHaveBeenCalledOnce();
  });

  it("leaves an editor alone when the undo deleted its file", async () => {
    const dirty = document("/repo/new.ts", true);
    workspace.textDocuments = [dirty];
    workspace.fs.readFile.mockRejectedValue(new Error("ENOENT"));

    await syncSnapshotDocuments(["/repo/new.ts"], "reload");

    expect(workspace.applyEdit).not.toHaveBeenCalled();
    expect(dirty.save).not.toHaveBeenCalled();
  });
});
