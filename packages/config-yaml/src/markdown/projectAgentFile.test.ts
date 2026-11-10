import {
  createInitPrompt,
  DEFAULT_PROJECT_AGENT_FILE,
  PROJECT_AGENT_FILE_NAMES,
} from "./projectAgentFile.js";

describe("createInitPrompt", () => {
  it("lists every project agent file in lookup order", () => {
    const prompt = createInitPrompt();
    const positions = PROJECT_AGENT_FILE_NAMES.map((name) =>
      prompt.indexOf(`\`${name}\``),
    );

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("creates AGENTS.md when no agent file exists", () => {
    expect(DEFAULT_PROJECT_AGENT_FILE).toBe("AGENTS.md");
    expect(createInitPrompt()).toContain(
      `If none exists, create \`AGENTS.md\` at the workspace root.`,
    );
  });

  it("does not ask for files outside the project agent file", () => {
    const prompt = createInitPrompt();
    expect(prompt).not.toContain("CONTINUE.md");
    expect(prompt).not.toContain(".continue/rules");
  });
});
