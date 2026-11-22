import { describe, expect, it } from "vitest";

import { ToolExtras } from "../..";
import { readCurrentlyOpenFileImpl } from "./readCurrentlyOpenFile";

const WORKSPACE = "file:///home/me/proj";
const CONTENTS = "the file's contents";

function extrasWithOpenFile(path: string | undefined): ToolExtras {
  return {
    ide: {
      getWorkspaceDirs: async () => [WORKSPACE],
      fileExists: async () => true,
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

const read = (path: string | undefined) =>
  readCurrentlyOpenFileImpl({}, extrasWithOpenFile(path));

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
