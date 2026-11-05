import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IDE } from "..";
import { loadCodebaseRules } from "../config/markdown/loadCodebaseRules";
import { joinPathsToUri } from "../util/uri";
import { walkDir, walkDirCache, walkDirs } from "./walkDir";

const FILE = 1;
const DIR = 2;

/**
 * An IDE over an in-memory tree. Listing a dir in `unreadable` throws, like
 * a virtual filesystem (e.g. SAP ABAP adt://) that types an object as a
 * directory but refuses to list it.
 */
function createIde(
  tree: Record<string, [string, number][]>,
  unreadable: string[] = [],
) {
  const listDir = vi.fn(async (dir: string) => {
    if (unreadable.includes(dir)) {
      const error = new Error(`Operation not supported for object ${dir}`);
      error.name = "FileSystemError";
      throw error;
    }
    return tree[dir] ?? [];
  });
  const ide = {
    getWorkspaceDirs: async () =>
      Object.keys(tree).filter((dir) => !dir.slice(8).includes("/")),
    listDir,
    readFile: async () => "Always answer in English.",
    fileExists: async () => false,
  } as unknown as IDE;
  return { ide, listDir };
}

const TREE: Record<string, [string, number][]> = {
  "file:///proj": [
    ["rules.md", FILE],
    ["src", DIR],
  ],
  "file:///proj/src": [["a.ts", FILE]],
  "adt://sys": [
    ["ENHC", DIR],
    ["README.txt", FILE],
  ],
  "adt://sys/ENHC": [
    ["XF ZEH_FBRA", DIR],
    ["ok.abap", FILE],
  ],
};
// Built the way the walker builds child uris (the space gets encoded)
const BROKEN = joinPathsToUri("adt://sys/ENHC", "XF ZEH_FBRA");

describe("walkDir with directories that can't be listed", () => {
  beforeEach(() => {
    walkDirCache.invalidate();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("skips an unreadable subdirectory and keeps its siblings", async () => {
    const { ide, listDir } = createIde(TREE, [BROKEN]);
    const files = await walkDir("adt://sys", ide);
    expect(listDir).toHaveBeenCalledWith(BROKEN);
    expect(files.sort()).toEqual([
      "adt://sys/ENHC/ok.abap",
      "adt://sys/README.txt",
    ]);
  });

  it("still fails when the directory asked for can't be listed", async () => {
    const { ide } = createIde(TREE, ["adt://sys"]);
    await expect(walkDir("adt://sys", ide)).rejects.toThrow(
      "Operation not supported",
    );
  });

  it("keeps the other workspace folders when one can't be listed", async () => {
    const { ide } = createIde(TREE, ["adt://sys"]);
    const files = await walkDirs(ide);
    expect(files.sort()).toEqual([
      "file:///proj/rules.md",
      "file:///proj/src/a.ts",
    ]);
  });

  it("doesn't cache a failed listing", async () => {
    const { ide, listDir } = createIde(TREE, [BROKEN]);
    await walkDir("adt://sys", ide);
    await walkDir("adt://sys", ide);
    const brokenCalls = listDir.mock.calls.filter(([dir]) => dir === BROKEN);
    expect(brokenCalls).toHaveLength(2);
  });
});

describe("walkDir with ignore files that can't be read", () => {
  beforeEach(() => {
    walkDirCache.invalidate();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("skips the directory instead of walking it with only the defaults", async () => {
    const { ide } = createIde({
      "file:///proj": [
        ["top.ts", FILE],
        ["sub", DIR],
      ],
      "file:///proj/sub": [
        [".gitignore", FILE],
        ["secret.ts", FILE],
      ],
    });
    (ide as any).readFile = async (uri: string) => {
      if (uri === "file:///proj/sub/.gitignore") {
        throw new Error("Operation not supported");
      }
      return "";
    };
    expect(await walkDir("file:///proj", ide)).toEqual(["file:///proj/top.ts"]);
  });
});

describe("loadCodebaseRules (continuedev/continue#13304)", () => {
  beforeEach(() => {
    walkDirCache.invalidate();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("loads rules.md from other folders when one has an unreadable dir", async () => {
    const { ide } = createIde(TREE, [BROKEN]);
    const { rules, errors } = await loadCodebaseRules(ide);
    expect(errors).toEqual([]);
    expect(rules.map((rule) => rule.sourceFile)).toEqual([
      "file:///proj/rules.md",
    ]);
  });
});
