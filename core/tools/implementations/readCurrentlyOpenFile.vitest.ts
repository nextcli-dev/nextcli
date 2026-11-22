import { describe, expect, it } from "vitest";

import { ToolExtras } from "../..";
import { readCurrentlyOpenFileImpl } from "./readCurrentlyOpenFile";

const WORKSPACE = "file:///home/me/proj";
const CONTENTS = "the file's contents";

function extrasWithOpenFile(
  path: string | undefined,
  workspace = WORKSPACE,
): ToolExtras {
  return {
    ide: {
      getWorkspaceDirs: async () => [workspace],
      // The IDE hands over an open document: whether it is on disk doesn't
      // decide anything
      fileExists: async () => false,
      getCurrentFile: async () =>
        path === undefined
          ? undefined
          : {
              isUntitled: path.startsWith("untitled:"),
              path,
              contents: CONTENTS,
            },
    },
    config: { selectedModelByRole: { chat: null } },
  } as unknown as ToolExtras;
}

const read = (path: string | undefined, workspace?: string) =>
  readCurrentlyOpenFileImpl({}, extrasWithOpenFile(path, workspace));

describe("readCurrentlyOpenFileImpl", () => {
  it("reads a saved file in the workspace", async () => {
    const [item] = await read(`${WORKSPACE}/src/app.ts`);
    expect(item.content).toContain(CONTENTS);
    expect(item.uri?.value).toBe(`${WORKSPACE}/src/app.ts`);
  });

  it.each([
    "file:///home/me/notes.txt",
    "file:///home/me/proj-other/src/app.ts",
  ])("doesn't read %s, outside the workspace, and names it", async (path) => {
    const [item] = await read(path);
    expect(item.content).not.toContain(CONTENTS);
    expect(item.content).toContain(new URL(path).pathname);
    expect(item.content).toContain("read_file");
  });

  it("reads a file in a remote workspace", async () => {
    const remote = "vscode-remote://ssh-remote%2Bbox/home/me/proj";
    const [item] = await read(`${remote}/src/app.ts`, remote);
    expect(item.content).toContain(CONTENTS);
  });

  it.each([
    // Another remote host, same folder path
    "vscode-remote://ssh-remote%2Bother/home/me/proj/src/app.ts",
    // The same folder path on this machine
    "file:///home/me/proj/src/app.ts",
  ])("doesn't read %s, outside the remote workspace", async (path) => {
    const remote = "vscode-remote://ssh-remote%2Bbox/home/me/proj";
    const [item] = await read(path, remote);
    expect(item.content).not.toContain(CONTENTS);
  });

  it("handles a URI with an encoded slash without throwing", async () => {
    const [inside] = await read(`${WORKSPACE}/src/a%2Fb.ts`);
    expect(inside.content).toContain(CONTENTS);
    const [outside] = await read("file:///home/me/a%2Fb.ts");
    expect(outside.content).not.toContain(CONTENTS);
    expect(outside.content).toContain("file:///home/me/a%2Fb.ts");
  });

  it("doesn't read an unsaved file", async () => {
    const [item] = await read("untitled:Untitled-1");
    expect(item.content).not.toContain(CONTENTS);
  });

  it("still refuses a secret-like file", async () => {
    await expect(read(`${WORKSPACE}/.env`)).rejects.toThrow();
  });

  it("says when no file is open", async () => {
    const [item] = await read(undefined);
    expect(item.content).toBe("There are no files currently open.");
  });
});
