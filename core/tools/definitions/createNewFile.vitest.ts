import { ToolPolicy } from "@continuedev/terminal-security";
import { describe, expect, it } from "vitest";
import { IDE } from "../..";
import { createNewFileTool } from "./createNewFile";

const WORKSPACE = "file:///home/me/proj";

// /tmp exists at the filesystem root; nothing else does yet
const ide = {
  getWorkspaceDirs: async () => [WORKSPACE],
  fileExists: async (uri: string) => uri === "file:///tmp",
  getCurrentFile: async () => undefined,
} as unknown as IDE;

// What the GUI does: preprocess the args, then evaluate the policy with them
async function policyFor(filepath: string, basePolicy: ToolPolicy) {
  const processedArgs = await createNewFileTool.preprocessArgs!(
    { filepath, contents: "" },
    { ide },
  );
  return createNewFileTool.evaluateToolCallPolicy!(
    basePolicy,
    { filepath },
    processedArgs,
  );
}

describe("createNewFileTool policy", () => {
  it.each(["src/new.ts", "/home/me/proj/new.ts", "/src/new.ts"])(
    "keeps the base policy for %s, inside the workspace",
    async (filepath) => {
      expect(await policyFor(filepath, "allowedWithoutPermission")).toBe(
        "allowedWithoutPermission",
      );
    },
  );

  it.each(["/tmp/new.ts", "../outside.ts", "~/new.ts"])(
    "asks before creating %s outside the workspace, even when automatic",
    async (filepath) => {
      expect(await policyFor(filepath, "allowedWithoutPermission")).toBe(
        "allowedWithPermission",
      );
    },
  );

  it("keeps a disabled tool disabled", async () => {
    expect(await policyFor("/tmp/new.ts", "disabled")).toBe("disabled");
  });

  it("asks when the path was not resolved", () => {
    expect(
      createNewFileTool.evaluateToolCallPolicy!(
        "allowedWithoutPermission",
        {},
        undefined,
      ),
    ).toBe("allowedWithPermission");
  });
});
