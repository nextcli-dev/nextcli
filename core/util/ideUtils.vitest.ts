import { describe, expect, it } from "vitest";
import { IDE } from "..";
import { resolveEditableFileUri } from "./ideUtils";
import { isSameLocalPath } from "./uri";

const WORKSPACE = "file:///c%3A/My%20Projects/demo";
const INDEX = `${WORKSPACE}/src/index.js`;
const OUTSIDE_OPEN = "file:///c%3A/notes/todo%20list.md";

// Files exist as VS Code sees them; fileExists, like vscode.Uri.parse,
// accepts either URI spelling of the same file
function mockIde(files: string[], openFiles: string[] = []): IDE {
  return {
    getWorkspaceDirs: async () => [WORKSPACE],
    fileExists: async (uri: string) =>
      files.some((file) => isSameLocalPath(file, uri)),
    getOpenFiles: async () => openFiles,
  } as unknown as IDE;
}

describe("resolveEditableFileUri", () => {
  const ide = mockIde([INDEX, OUTSIDE_OPEN], [OUTSIDE_OPEN]);

  it.each([
    ["src/index.js"],
    ["./src/index.js"],
    ["src\\index.js"],
    [".\\src\\index.js"],
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

  it("rejects an absolute path outside the workspace that is not open", async () => {
    const withClosedFile = mockIde([INDEX, "file:///c%3A/secrets/key.txt"]);
    expect(
      await resolveEditableFileUri("C:\\secrets\\key.txt", withClosedFile),
    ).toBeUndefined();
    expect(
      await resolveEditableFileUri(
        "C:\\My Projects\\demo\\..\\..\\secrets\\key.txt",
        withClosedFile,
      ),
    ).toBeUndefined();
  });

  it("rejects a missing file", async () => {
    expect(
      await resolveEditableFileUri(
        "C:\\My Projects\\demo\\src\\missing.js",
        ide,
      ),
    ).toBeUndefined();
    expect(await resolveEditableFileUri("src/missing.js", ide)).toBeUndefined();
  });

  it("still reads a leading / as workspace-relative on POSIX", async () => {
    const posixWorkspace = "file:///home/me/proj";
    const posixIde = {
      getWorkspaceDirs: async () => [posixWorkspace],
      fileExists: async (uri: string) => uri === `${posixWorkspace}/src/a.ts`,
      getOpenFiles: async () => [],
    } as unknown as IDE;
    expect(await resolveEditableFileUri("/src/a.ts", posixIde)).toBe(
      `${posixWorkspace}/src/a.ts`,
    );
    expect(
      await resolveEditableFileUri("/home/me/proj/src/a.ts", posixIde),
    ).toBe(`${posixWorkspace}/src/a.ts`);
  });
});
