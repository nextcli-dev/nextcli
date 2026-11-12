import { describe, expect, it } from "vitest";
import { IDE } from "../..";
import { ContinueError } from "../../util/errors";
import { validateSearchAndReplaceFilepath } from "./validateArgs";

const WORKSPACE = "file:///c%3A/My%20Projects/demo";
const FILE = `${WORKSPACE}/src/index.js`;

const ide = {
  getWorkspaceDirs: async () => [WORKSPACE],
  fileExists: async (uri: string) => uri === FILE,
  getOpenFiles: async () => [],
} as unknown as IDE;

describe("validateSearchAndReplaceFilepath", () => {
  it.each([
    "src/index.js",
    "src\\index.js",
    "C:\\My Projects\\demo\\src\\index.js",
    "file:///C:/My%20Projects/demo/src/index.js",
  ])("accepts %s", async (filepath) => {
    expect(await validateSearchAndReplaceFilepath(filepath, ide)).toBe(FILE);
  });

  it("rejects a file that does not exist", async () => {
    await expect(
      validateSearchAndReplaceFilepath("C:\\other\\index.js", ide),
    ).rejects.toThrow(ContinueError);
  });

  // The diff for it is never auto-accepted (handleApplyStateUpdate)
  it("accepts an existing file outside the workspace", async () => {
    const outside = "file:///c%3A/other/index.js";
    const withOutside = {
      ...ide,
      fileExists: async (uri: string) => uri === FILE || uri === outside,
    } as unknown as IDE;
    expect(
      await validateSearchAndReplaceFilepath(
        "C:\\other\\index.js",
        withOutside,
      ),
    ).toBe(outside);
  });
});
