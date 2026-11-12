import { describe, expect, it } from "vitest";
import { IDE } from "..";
import { resolveInputPath } from "./pathResolver";

describe("resolveInputPath workspace check", () => {
  it("counts a file:///C:/ URI as inside a file:///c%3A/ workspace", async () => {
    const ide = {
      getWorkspaceDirs: async () => ["file:///c%3A/My%20Projects/demo"],
      fileExists: async () => true,
    } as unknown as IDE;

    const resolved = await resolveInputPath(
      ide,
      "file:///C:/My%20Projects/demo/src/index.js",
    );

    expect(resolved?.isWithinWorkspace).toBe(true);
  });

  it("counts a file outside the workspace as outside", async () => {
    const ide = {
      getWorkspaceDirs: async () => ["file:///c%3A/My%20Projects/demo"],
      fileExists: async () => true,
    } as unknown as IDE;

    const resolved = await resolveInputPath(
      ide,
      "file:///C:/My%20Projects/demo2/src/index.js",
    );

    expect(resolved?.isWithinWorkspace).toBe(false);
  });

  it("counts an absolute POSIX path inside the workspace", async () => {
    const ide = {
      getWorkspaceDirs: async () => ["file:///home/me/my%20proj"],
      fileExists: async () => true,
    } as unknown as IDE;

    const resolved = await resolveInputPath(ide, "/home/me/my proj/a.ts");

    expect(resolved?.isWithinWorkspace).toBe(true);
  });
});
