import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IDE } from "..";
import { shouldIgnore } from "./shouldIgnore";

/** An IDE over an in-memory tree; dirs not in the tree list as empty */
function createIde(
  tree: Record<string, [string, number][]>,
  files: Record<string, string> = {},
  unreadable: string[] = [],
) {
  const listDir = vi.fn(async (dir: string) => {
    if (unreadable.includes(dir)) {
      throw new Error(`Operation not supported for object ${dir}`);
    }
    return tree[dir] ?? [];
  });
  const ide = {
    listDir,
    readFile: async (file: string) => files[file] ?? "",
  } as unknown as IDE;
  return { ide, listDir };
}

describe("shouldIgnore", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("doesn't throw on a parent that can't be listed", async () => {
    const { ide } = createIde({}, {}, ["file:///proj/ENHC"]);
    await expect(
      shouldIgnore("file:///proj/ENHC/obj.ts", ide, ["file:///proj"]),
    ).resolves.toBe(false);
  });

  // The SAP ABAP filesystem's workspace folder is adt://<system>
  it("checks files under a root with an empty path", async () => {
    const { ide, listDir } = createIde(
      { "adt://sys": [[".gitignore", 1]] },
      { "adt://sys/.gitignore": "ignored/\n" },
    );
    await expect(
      shouldIgnore("adt://sys/ENHC/obj.abap", ide, ["adt://sys"]),
    ).resolves.toBe(false);
    await expect(
      shouldIgnore("adt://sys/ignored/obj.abap", ide, ["adt://sys"]),
    ).resolves.toBe(true);
    expect(listDir.mock.calls.map(([dir]) => dir)).toContain("adt://sys");
  });

  it("stops at a root written with a trailing slash", async () => {
    const { ide, listDir } = createIde({});
    await expect(
      shouldIgnore("file:///proj/a/b.ts", ide, ["file:///proj/"]),
    ).resolves.toBe(false);
    expect(listDir.mock.calls.map(([dir]) => dir)).toEqual([
      "file:///proj/a",
      "file:///proj/",
    ]);
  });

  it("does not ignore the root itself", async () => {
    const { ide } = createIde({});
    await expect(
      shouldIgnore("file:///proj", ide, ["file:///proj"]),
    ).resolves.toBe(false);
  });
});
