import { describe, expect, it, vi } from "vitest";
import { createNewFileImpl } from "./createNewFile";

const WORKSPACE = "file:///c%3A/My%20Projects/demo";

function mockExtras() {
  const ide = {
    getWorkspaceDirs: vi.fn().mockResolvedValue([WORKSPACE]),
    fileExists: vi.fn().mockResolvedValue(false),
    getCurrentFile: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    openFile: vi.fn().mockResolvedValue(undefined),
    saveFile: vi.fn().mockResolvedValue(undefined),
  };
  return { ide, extras: { ide } as any };
}

describe("createNewFileImpl", () => {
  it("creates a file given by a Windows absolute path inside the workspace", async () => {
    const { ide, extras } = mockExtras();

    await createNewFileImpl(
      {
        filepath: "C:\\My Projects\\demo\\src\\new file.ts",
        contents: "x",
      },
      extras,
    );

    expect(ide.writeFile).toHaveBeenCalledWith(
      `${WORKSPACE}/src/new%20file.ts`,
      "x",
    );
  });

  it("still creates a relative path under the workspace", async () => {
    const { ide, extras } = mockExtras();

    await createNewFileImpl({ filepath: "src\\new.ts", contents: "x" }, extras);

    expect(ide.writeFile).toHaveBeenCalledWith(`${WORKSPACE}/src/new.ts`, "x");
  });
});
