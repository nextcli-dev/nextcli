import {
  createInitPrompt,
  DEFAULT_PROJECT_AGENT_FILE,
  InitPromptOptions,
  PROJECT_AGENT_FILE_NAMES,
} from "./projectAgentFile.js";

const baseOptions: InitPromptOptions = {
  targetPath: "/repo/AGENTS.md",
  targetExists: false,
  directoryLabel: "working directory",
  tools: { read: "ReadTool", create: "CreateTool", edit: "EditTool" },
  noWriteToolsHint: "Switch to a mode that can edit files.",
};

describe("project agent file names", () => {
  it("prefers AGENTS.md, then AGENT.md, CLAUDE.md and CODEX.md", () => {
    expect(PROJECT_AGENT_FILE_NAMES).toEqual([
      "AGENTS.md",
      "AGENT.md",
      "CLAUDE.md",
      "CODEX.md",
    ]);
    expect(DEFAULT_PROJECT_AGENT_FILE).toBe("AGENTS.md");
  });
});

describe("createInitPrompt", () => {
  it("creates the resolved path with the create tool when no file exists", () => {
    const prompt = createInitPrompt(baseOptions);

    expect(prompt).toContain(
      "Create `/repo/AGENTS.md` with the `CreateTool` tool",
    );
    expect(prompt).toContain("loaded from the working directory");
    expect(prompt).not.toContain("Update it in place");
  });

  it("updates an existing file with the edit tool and forbids creating another", () => {
    const prompt = createInitPrompt({
      ...baseOptions,
      targetPath: "/repo/CLAUDE.md",
      targetExists: true,
    });

    expect(prompt).toContain(
      "The agent file for this project is `/repo/CLAUDE.md`",
    );
    expect(prompt).toContain("change it with the `EditTool` tool");
    expect(prompt).toContain("Do not use the `CreateTool` tool on this file");
    expect(prompt).not.toContain("AGENTS.md");
  });

  it("tells the model to stop when it has no write tools", () => {
    for (const targetExists of [true, false]) {
      const prompt = createInitPrompt({ ...baseOptions, targetExists });
      expect(prompt).toContain(
        "If you don't have the `CreateTool` and `EditTool` tools, stop and tell the user: Switch to a mode that can edit files.",
      );
    }
  });

  it("merges and deletes a leftover CONTINUE.md only when one exists", () => {
    const withoutLegacy = createInitPrompt(baseOptions);
    expect(withoutLegacy).not.toContain("CONTINUE.md");
    expect(withoutLegacy).toContain("## Step 4: Finish");

    const withLegacy = createInitPrompt({
      ...baseOptions,
      legacyRulePath: "/repo/.continue/rules/CONTINUE.md",
    });
    expect(withLegacy).toContain(
      "`/repo/.continue/rules/CONTINUE.md` was written by an older version of `/init`",
    );
    expect(withLegacy).toContain('rm "/repo/.continue/rules/CONTINUE.md"');
    expect(withLegacy).toContain("## Step 5: Finish");
  });
});
