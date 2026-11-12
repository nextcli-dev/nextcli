import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IDE } from "..";
import { ContinueError } from "./errors";
import { resolveInputPath, resolveNewFilePath } from "./pathResolver";
import { isSameLocalPath } from "./uri";

describe("resolveInputPath for relative paths", () => {
  // Every path exists; only where it lands decides the answer
  const ide = {
    getWorkspaceDirs: async () => ["file:///home/me/proj", "file:///home/me/b"],
    fileExists: async () => true,
  } as unknown as IDE;

  it.each([".", "src/a.ts", "../b/x.ts"])(
    "counts %s as inside the workspace",
    async (input) => {
      expect((await resolveInputPath(ide, input))?.isWithinWorkspace).toBe(
        true,
      );
    },
  );

  it.each(["..", "../../../etc/passwd"])(
    "counts %s, which climbs out, as outside the workspace",
    async (input) => {
      expect((await resolveInputPath(ide, input))?.isWithinWorkspace).toBe(
        false,
      );
    },
  );

  it("counts the workspace folder itself as inside, for ls", async () => {
    expect(
      (await resolveInputPath(ide, "/home/me/proj"))?.isWithinWorkspace,
    ).toBe(true);
  });

  it("counts a file:// URI that climbs out with \\ as outside", async () => {
    const windowsIde = {
      getWorkspaceDirs: async () => ["file:///c%3A/Users/me/proj"],
      fileExists: async () => true,
    } as unknown as IDE;
    expect(
      (
        await resolveInputPath(
          windowsIde,
          "file:///c%3A/Users/me/proj/..%5C..%5C.git-credentials",
        )
      )?.isWithinWorkspace,
    ).toBe(false);
  });
});

describe("resolveNewFilePath", () => {
  const WORKSPACE = "file:///home/me/proj";

  // Folders and files that exist, by exact URI. /src exists both at the
  // filesystem root and in the workspace; /tmp only at the root
  function mockIde(
    workspaceDirs = [WORKSPACE],
    existing = [`${WORKSPACE}/src`, "file:///src", "file:///tmp"],
  ): IDE {
    return {
      getWorkspaceDirs: async () => workspaceDirs,
      fileExists: async (uri: string) => existing.includes(uri),
      getCurrentFile: async () => undefined,
    } as unknown as IDE;
  }

  it.each([
    ["src/new.ts", `${WORKSPACE}/src/new.ts`],
    [".continue/rules/r.md", `${WORKSPACE}/.continue/rules/r.md`],
    ["/home/me/proj/src/new.ts", `${WORKSPACE}/src/new.ts`],
    // The workspace has src, so /src means the workspace's
    ["/src/new.ts", `${WORKSPACE}/src/new.ts`],
    // Neither the workspace nor the root has newdir
    ["/newdir/x.ts", `${WORKSPACE}/newdir/x.ts`],
  ])("creates %s inside the workspace", async (input, expected) => {
    expect(await resolveNewFilePath(mockIde(), input)).toMatchObject({
      uri: expected,
      isWithinWorkspace: true,
    });
  });

  it.each([
    ["../../x.ts", "file:///home/x.ts"],
    ["/tmp/new.ts", "file:///tmp/new.ts"],
    ["///server/share/x.ts", "file://server/share/x.ts"],
    ["file:///home/me/proj/..%5C..%5Cx.ts", "file:///home/x.ts"],
  ])(
    "creates %s outside the workspace, where it points",
    async (input, expected) => {
      expect(await resolveNewFilePath(mockIde(), input)).toMatchObject({
        uri: expected,
        isWithinWorkspace: false,
      });
    },
  );

  it("creates a Windows path outside the workspace where it points", async () => {
    const ide = mockIde(["file:///c%3A/My%20Projects/demo"], []);
    expect(await resolveNewFilePath(ide, "C:\\other\\x.ts")).toMatchObject({
      uri: "file:///c%3A/other/x.ts",
      isWithinWorkspace: false,
    });
  });

  it("expands ~ to the home folder", async () => {
    const resolved = await resolveNewFilePath(mockIde(), "~/x.ts");
    expect(isSameLocalPath(resolved.uri, join(homedir(), "x.ts"))).toBe(true);
    expect(resolved.isWithinWorkspace).toBe(false);
  });

  it("creates a path inside a remote workspace on its filesystem", async () => {
    const ssh = "vscode-remote://ssh-remote%2Bhost/home/me/proj";
    expect(
      await resolveNewFilePath(mockIde([ssh], []), "/home/me/proj/new.ts"),
    ).toMatchObject({ uri: `${ssh}/new.ts`, isWithinWorkspace: true });
  });

  it("rejects a workspace folder and a URI on another filesystem", async () => {
    await expect(
      resolveNewFilePath(mockIde(), "/home/me/proj"),
    ).rejects.toThrow(ContinueError);
    await expect(
      resolveNewFilePath(mockIde(), "vscode-userdata:/User/settings.json"),
    ).rejects.toThrow(ContinueError);
  });
});

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
