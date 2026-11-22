import { ToolPolicy } from "@continuedev/terminal-security";
import { describe, expect, it } from "vitest";
import { IDE } from "../..";
import { readCurrentlyOpenFileTool } from "./readCurrentlyOpenFile";

const WORKSPACE = "file:///home/me/proj";

function ideWithOpenFile(path: string | undefined): IDE {
  return {
    getWorkspaceDirs: async () => [WORKSPACE],
    fileExists: async () => true,
    getCurrentFile: async () =>
      path === undefined
        ? undefined
        : { isUntitled: path.startsWith("untitled:"), path, contents: "x" },
  } as unknown as IDE;
}

// What the GUI does: preprocess the args, then evaluate the policy with them
async function policyFor(
  openFile: string | undefined,
  basePolicy: ToolPolicy = readCurrentlyOpenFileTool.defaultToolPolicy!,
) {
  const processedArgs = await readCurrentlyOpenFileTool.preprocessArgs!(
    {},
    { ide: ideWithOpenFile(openFile) },
  );
  return readCurrentlyOpenFileTool.evaluateToolCallPolicy!(
    basePolicy,
    {},
    processedArgs,
  );
}

describe("readCurrentlyOpenFileTool policy", () => {
  it("reads a file in the workspace without asking", async () => {
    expect(await policyFor(`${WORKSPACE}/src/app.ts`)).toBe(
      "allowedWithoutPermission",
    );
  });

  it.each([
    "file:///home/me/.aws/credentials",
    "file:///home/me/proj-other/a.ts",
    "untitled:Untitled-1",
  ])("asks before reading %s, outside the workspace", async (openFile) => {
    expect(await policyFor(openFile)).toBe("allowedWithPermission");
  });

  it("doesn't ask when no file is open", async () => {
    expect(await policyFor(undefined)).toBe("allowedWithoutPermission");
  });

  it("asks when the args weren't preprocessed", () => {
    expect(
      readCurrentlyOpenFileTool.evaluateToolCallPolicy!(
        "allowedWithoutPermission",
        {},
        undefined,
      ),
    ).toBe("allowedWithPermission");
  });

  it("keeps a user's Ask First and Excluded settings", async () => {
    expect(
      await policyFor(`${WORKSPACE}/src/app.ts`, "allowedWithPermission"),
    ).toBe("allowedWithPermission");
    expect(await policyFor(`${WORKSPACE}/src/app.ts`, "disabled")).toBe(
      "disabled",
    );
  });
});
