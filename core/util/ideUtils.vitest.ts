import { describe, expect, it, vi } from "vitest";
import { IDE } from "..";
import {
  inferResolvedUriFromRelativePath,
  resolveEditableFileUri,
} from "./ideUtils";
import { findLocalPathInDirs, isSameLocalPath } from "./uri";

const WORKSPACE = "file:///c%3A/My%20Projects/demo";
const INDEX = `${WORKSPACE}/src/index.js`;
const OUTSIDE_OPEN = "file:///c%3A/notes/todo%20list.md";
const OUTSIDE = "file:///c%3A/secrets/key.txt";

// Files and folders exist as VS Code sees them (fileExists is true for
// folders too); fileExists, like vscode.Uri.parse, accepts either URI
// spelling of the same file
function mockIde(files: string[], openFiles: string[] = []): IDE {
  return {
    getWorkspaceDirs: vi.fn(async () => [WORKSPACE]),
    fileExists: vi.fn(async (uri: string) =>
      files.some((file) => isSameLocalPath(file, uri)),
    ),
    getOpenFiles: vi.fn(async () => openFiles),
  } as unknown as IDE;
}

// Matches URIs exactly, so a file:// URI is not taken for a remote one
function exactIde(workspaceDirs: string[], files: string[]): IDE {
  return {
    getWorkspaceDirs: async () => workspaceDirs,
    fileExists: async (uri: string) => files.includes(uri),
    getOpenFiles: async () => [],
  } as unknown as IDE;
}

describe("resolveEditableFileUri", () => {
  const ide = mockIde([INDEX, OUTSIDE_OPEN], [OUTSIDE_OPEN]);

  it.each([
    ["src/index.js"],
    ["./src/index.js"],
    ["src\\index.js"],
    [".\\src\\index.js"],
    ["src/../src/index.js"],
    ["C:\\My Projects\\demo\\src\\index.js"],
    ["c:/My Projects/demo/src/index.js"],
    ["file:///C:/My%20Projects/demo/src/index.js"],
    [INDEX],
  ])("resolves %s to the workspace file", async (input) => {
    const uri = await resolveEditableFileUri(input, ide);
    expect(uri).toBeDefined();
    expect(isSameLocalPath(uri!, INDEX)).toBe(true);
  });

  it("resolves an absolute path to an open file outside the workspace", async () => {
    expect(await resolveEditableFileUri("C:\\notes\\todo list.md", ide)).toBe(
      OUTSIDE_OPEN,
    );
  });

  it("resolves the last parts of an open file's path", async () => {
    expect(await resolveEditableFileUri("notes\\todo list.md", ide)).toBe(
      OUTSIDE_OPEN,
    );
  });

  // handleApplyStateUpdate never auto-accepts an edit to such a file
  it.each([
    ["C:\\secrets\\key.txt"],
    ["C:\\My Projects\\demo\\..\\..\\secrets\\key.txt"],
    ["..\\..\\secrets\\key.txt"],
    ["file:///c%3A/My%20Projects/demo/..%5C..%5Csecrets%5Ckey.txt"],
  ])("resolves %s to the file outside the workspace", async (input) => {
    const uri = await resolveEditableFileUri(input, mockIde([INDEX, OUTSIDE]));
    expect(uri).toBeDefined();
    expect(isSameLocalPath(uri!, OUTSIDE)).toBe(true);
    expect(findLocalPathInDirs(uri!, [WORKSPACE])).toBeUndefined();
  });

  it("rejects a missing file", async () => {
    expect(
      await resolveEditableFileUri(
        "C:\\My Projects\\demo\\src\\missing.js",
        ide,
      ),
    ).toBeUndefined();
    expect(await resolveEditableFileUri("src/missing.js", ide)).toBeUndefined();
    expect(
      await resolveEditableFileUri("C:\\elsewhere\\missing.js", ide),
    ).toBeUndefined();
  });

  it.each([["C:\\My Projects\\demo"], [WORKSPACE], ["."], ["src/.."]])(
    "never resolves %s, a workspace folder itself",
    async (input) => {
      const withFolders = mockIde([INDEX, WORKSPACE, `${WORKSPACE}/src`]);
      expect(await resolveEditableFileUri(input, withFolders)).toBeUndefined();
    },
  );

  it.each([
    ["C:\\elsewhere\\missing.js"],
    ["/elsewhere/missing.js"],
    ["missing.js"],
  ])(
    "asks for the workspace folders once and the open files at most once (%s)",
    async (input) => {
      const counting = mockIde([INDEX]);
      expect(await resolveEditableFileUri(input, counting)).toBeUndefined();
      expect(counting.getWorkspaceDirs).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(counting.getOpenFiles).mock.calls.length,
      ).toBeLessThanOrEqual(1);
    },
  );

  describe("POSIX paths", () => {
    const POSIX = "file:///home/me/proj";

    it("reads /src/a.ts in the workspace first, even when it exists at the root", async () => {
      const posixIde = exactIde(
        [POSIX],
        [`${POSIX}/src/a.ts`, "file:///src/a.ts"],
      );
      expect(await resolveEditableFileUri("/src/a.ts", posixIde)).toBe(
        `${POSIX}/src/a.ts`,
      );
      expect(
        await resolveEditableFileUri("/home/me/proj/src/a.ts", posixIde),
      ).toBe(`${POSIX}/src/a.ts`);
    });

    it("resolves a file outside the workspace by absolute path or ..", async () => {
      const posixIde = exactIde(
        [POSIX],
        ["file:///tmp/x.ts", "file:///home/me/notes.md"],
      );
      expect(await resolveEditableFileUri("/tmp/x.ts", posixIde)).toBe(
        "file:///tmp/x.ts",
      );
      expect(await resolveEditableFileUri("../notes.md", posixIde)).toBe(
        "file:///home/me/notes.md",
      );
    });

    it("treats ///etc/passwd as a file outside the workspace", async () => {
      const uri = await resolveEditableFileUri(
        "///etc/passwd",
        exactIde([POSIX], ["file://etc/passwd"]),
      );
      expect(uri).toBe("file://etc/passwd");
      expect(findLocalPathInDirs(uri!, [POSIX])).toBeUndefined();
    });
  });

  it("resolves .. into another workspace folder", async () => {
    const multiRoot = exactIde(
      ["file:///ws/a", "file:///ws/b"],
      ["file:///ws/b/x.ts"],
    );
    expect(await resolveEditableFileUri("../b/x.ts", multiRoot)).toBe(
      "file:///ws/b/x.ts",
    );
  });

  it("resolves paths on a remote workspace's filesystem", async () => {
    const ssh = "vscode-remote://ssh-remote%2Bhost/home/me/proj";
    expect(
      await resolveEditableFileUri(
        "src/a.ts",
        exactIde([ssh], [`${ssh}/src/a.ts`]),
      ),
    ).toBe(`${ssh}/src/a.ts`);

    const wsl = "vscode-remote://wsl%2Bubuntu/home/me/proj";
    const wslTmp = "vscode-remote://wsl%2Bubuntu/tmp/x.ts";
    expect(
      await resolveEditableFileUri("/tmp/x.ts", exactIde([wsl], [wslTmp])),
    ).toBe(wslTmp);
  });
});

describe("inferResolvedUriFromRelativePath", () => {
  it("matches the active file by whole path parts", async () => {
    const workspace = "file:///home/me/proj";
    const ide = {
      getWorkspaceDirs: async () => [workspace],
      fileExists: async () => false,
      getCurrentFile: async () => ({ path: `${workspace}/src/data.ts` }),
    } as unknown as IDE;

    expect(await inferResolvedUriFromRelativePath("a.ts", ide)).toBe(
      `${workspace}/a.ts`,
    );
    expect(await inferResolvedUriFromRelativePath("data.ts", ide)).toBe(
      `${workspace}/src/data.ts`,
    );
  });
});
