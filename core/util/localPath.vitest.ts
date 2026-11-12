import { describe, expect, it } from "vitest";
import {
  findLocalPathInDirs,
  isAbsoluteLocalPath,
  isSameLocalPath,
  localPathEndsWith,
  localPathKey,
} from "./uri";

// VS Code gives Windows workspace folders as file:///c%3A/... (lowercase
// drive letter, encoded colon), while models write C:\... paths
const WIN_WORKSPACE = "file:///c%3A/My%20Projects/demo";

describe("isAbsoluteLocalPath", () => {
  it.each([
    ["C:\\proj\\a.ts", true],
    ["c:/proj/a.ts", true],
    ["C:", true],
    ["\\\\server\\share\\a.ts", true],
    ["/home/me/a.ts", true],
    ["src\\a.ts", false],
    ["src/a.ts", false],
    ["./a.ts", false],
    ["C:a.ts", false],
  ])("%s -> %s", (path, expected) => {
    expect(isAbsoluteLocalPath(path)).toBe(expected);
  });
});

describe("localPathKey", () => {
  it.each([
    ["C:\\My Projects\\demo\\a.ts", "c:/My Projects/demo/a.ts"],
    ["file:///c%3A/My%20Projects/demo/a.ts", "c:/My Projects/demo/a.ts"],
    ["file:///C:/My%20Projects/demo/a.ts", "c:/My Projects/demo/a.ts"],
    ["\\\\Server\\share\\a.ts", "//Server/share/a.ts"],
    ["file://server/share/a.ts", "//server/share/a.ts"],
    ["/home/me/a.ts", "/home/me/a.ts"],
    ["vscode-remote://wsl%2Bubuntu/home/me/a.ts", "/home/me/a.ts"],
    ["file:///%D1%84%D0%B0%D0%B9%D0%BB.ts", "/файл.ts"],
    ["src\\lib\\a.ts", "src/lib/a.ts"],
    ["C:\\proj\\..\\other\\.\\a.ts", "c:/other/a.ts"],
    ["C:\\..\\..\\a.ts", "c:/a.ts"],
    ["/a/../../b", "/b"],
    ["../a.ts", "../a.ts"],
  ])("%s -> %s", (input, expected) => {
    expect(localPathKey(input)).toBe(expected);
  });

  it("keeps a malformed escape instead of throwing", () => {
    expect(localPathKey("file:///proj/100%.ts")).toBe("/proj/100%.ts");
  });
});

describe("isSameLocalPath", () => {
  it("matches a Windows path with the URI VS Code uses for it", () => {
    expect(
      isSameLocalPath(
        "C:\\My Projects\\demo\\a(1).ts",
        "file:///c%3A/My%20Projects/demo/a%281%29.ts",
      ),
    ).toBe(true);
  });

  it("ignores case on Windows paths only", () => {
    expect(isSameLocalPath("C:\\PROJ\\A.ts", "file:///c%3A/proj/a.ts")).toBe(
      true,
    );
    expect(isSameLocalPath("/proj/A.ts", "file:///proj/a.ts")).toBe(false);
  });
});

describe("localPathEndsWith", () => {
  const uri = "file:///c%3A/My%20Projects/demo/src/my%20file.ts";

  it("matches whole trailing parts in any separator style", () => {
    expect(localPathEndsWith(uri, "src\\my file.ts")).toBe(true);
    expect(localPathEndsWith(uri, "src/my file.ts")).toBe(true);
    expect(localPathEndsWith(uri, "SRC/My File.ts")).toBe(true);
  });

  it("does not match a partial part, an absolute path or ..", () => {
    expect(localPathEndsWith(uri, "rc/my file.ts")).toBe(false);
    expect(localPathEndsWith(uri, "C:\\other\\src\\my file.ts")).toBe(false);
    expect(localPathEndsWith(uri, "../src/my file.ts")).toBe(false);
    expect(localPathEndsWith(uri, "")).toBe(false);
  });
});

describe("findLocalPathInDirs", () => {
  it("finds a Windows absolute path in a VS Code workspace folder", () => {
    expect(
      findLocalPathInDirs("C:\\My Projects\\demo\\src\\файл.ts", [
        "file:///c%3A/other",
        WIN_WORKSPACE,
      ]),
    ).toEqual({ dirUri: WIN_WORKSPACE, relativePath: "src/файл.ts" });
  });

  it("finds file:// URIs written either way", () => {
    for (const uri of [
      "file:///C:/My%20Projects/demo/a.ts",
      "file:///c%3A/my%20projects/DEMO/a.ts",
    ]) {
      expect(findLocalPathInDirs(uri, [WIN_WORKSPACE])).toEqual({
        dirUri: WIN_WORKSPACE,
        relativePath: "a.ts",
      });
    }
  });

  it("finds UNC and POSIX paths", () => {
    expect(
      findLocalPathInDirs("\\\\server\\share\\proj\\a.ts", [
        "file://server/share/proj",
      ]),
    ).toEqual({ dirUri: "file://server/share/proj", relativePath: "a.ts" });
    expect(
      findLocalPathInDirs("/home/me/proj/a.ts", ["file:///home/me/proj"]),
    ).toEqual({ dirUri: "file:///home/me/proj", relativePath: "a.ts" });
  });

  it("finds an OS path in a remote workspace folder", () => {
    const dir = "vscode-remote://wsl%2Bubuntu/home/me/proj";
    expect(findLocalPathInDirs("/home/me/proj/a.ts", [dir])).toEqual({
      dirUri: dir,
      relativePath: "a.ts",
    });
  });

  it("matches a URI only against folders with its scheme and authority", () => {
    expect(
      findLocalPathInDirs("file:///home/me/proj/a.ts", [
        "vscode-remote://wsl%2Bubuntu/home/me/proj",
      ]),
    ).toBeUndefined();
  });

  it("does not match a sibling folder that shares a prefix", () => {
    expect(
      findLocalPathInDirs("C:\\proj2\\a.ts", ["file:///c%3A/proj"]),
    ).toBeUndefined();
    expect(
      findLocalPathInDirs("/home/me/proj2/a.ts", ["file:///home/me/proj"]),
    ).toBeUndefined();
  });

  it("does not let .. leave the workspace folder", () => {
    expect(
      findLocalPathInDirs("C:\\proj\\..\\secrets\\a.ts", ["file:///c%3A/proj"]),
    ).toBeUndefined();
    expect(
      findLocalPathInDirs("C:\\proj\\src\\..\\a.ts", ["file:///c%3A/proj"]),
    ).toEqual({ dirUri: "file:///c%3A/proj", relativePath: "a.ts" });
  });

  it("ignores relative paths and paths on another drive", () => {
    expect(findLocalPathInDirs("src\\a.ts", [WIN_WORKSPACE])).toBeUndefined();
    expect(
      findLocalPathInDirs("D:\\My Projects\\demo\\a.ts", [WIN_WORKSPACE]),
    ).toBeUndefined();
  });
});
