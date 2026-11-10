import { describe, expect, it, vi } from "vitest";
import { IDE } from "..";
import { createInitSlashCommand } from "./initPrompt";

function createIde(files: string[], workspaceDirs = ["file:///workspace"]) {
  return {
    getWorkspaceDirs: vi.fn().mockResolvedValue(workspaceDirs),
    fileExists: vi.fn(async (uri: string) => files.includes(uri)),
    readFile: vi.fn(async () => ""),
  } as unknown as IDE;
}

describe("createInitSlashCommand", () => {
  it("updates an existing CLAUDE.md with the edit tool", async () => {
    const command = await createInitSlashCommand(
      createIde(["file:///workspace/CLAUDE.md"]),
    );

    expect(command.description).toBe("Update CLAUDE.md");
    expect(command.prompt).toContain(
      "The agent file for this project is `CLAUDE.md`",
    );
    expect(command.prompt).toContain(
      "change it with the `edit_existing_file` tool",
    );
    expect(command.prompt).toContain(
      "Do not use the `create_new_file` tool on this file",
    );
    expect(command.prompt).not.toContain("AGENTS.md");
  });

  it("creates AGENTS.md with the create tool in an empty workspace", async () => {
    const command = await createInitSlashCommand(createIde([]));

    expect(command.description).toBe("Create AGENTS.md");
    expect(command.prompt).toContain(
      "Create `AGENTS.md` with the `create_new_file` tool",
    );
    expect(command.prompt).toContain("Switch to Agent mode");
    expect(command.prompt).not.toContain("CONTINUE.md");
  });

  it("merges and deletes a leftover CONTINUE.md", async () => {
    const command = await createInitSlashCommand(
      createIde(["file:///workspace/.continue/rules/CONTINUE.md"]),
    );

    expect(command.prompt).toContain(
      "`.continue/rules/CONTINUE.md` was written by an older version of `/init`",
    );
  });

  it("targets the file the loader uses across workspaces", async () => {
    const command = await createInitSlashCommand(
      createIde(
        [
          "file:///second/AGENT.md",
          "file:///second/.continue/rules/CONTINUE.md",
          "file:///third/AGENTS.md",
        ],
        ["file:///first", "file:///second", "file:///third"],
      ),
    );

    expect(command.description).toBe("Update AGENT.md");
    expect(command.prompt).toContain("`.continue/rules/CONTINUE.md`");
  });
});
