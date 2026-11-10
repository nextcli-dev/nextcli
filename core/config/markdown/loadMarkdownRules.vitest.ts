import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDE } from "../..";
import { getAllDotContinueDefinitionFiles } from "../loadLocalAssistants";
import { loadMarkdownRules } from "./loadMarkdownRules";

vi.mock("../loadLocalAssistants", () => ({
  getAllDotContinueDefinitionFiles: vi.fn(),
}));

const WORKSPACE = "file:///workspace";

function createIde(files: Record<string, string>, workspaceDirs = [WORKSPACE]) {
  return {
    getWorkspaceDirs: vi.fn().mockResolvedValue(workspaceDirs),
    fileExists: vi.fn(async (uri: string) => uri in files),
    readFile: vi.fn(async (uri: string) => {
      if (!(uri in files)) {
        throw new Error(`ENOENT: ${uri}`);
      }
      return files[uri];
    }),
  } as unknown as IDE;
}

describe("loadMarkdownRules agent files", () => {
  beforeEach(() => {
    vi.mocked(getAllDotContinueDefinitionFiles).mockReset();
    vi.mocked(getAllDotContinueDefinitionFiles).mockResolvedValue([]);
  });

  it.each(["AGENTS.md", "AGENT.md", "CLAUDE.md", "CODEX.md"])(
    "loads %s when it is the only agent file",
    async (fileName) => {
      const uri = `${WORKSPACE}/${fileName}`;
      const { rules, errors } = await loadMarkdownRules(
        createIde({ [uri]: `# Guide\nContent of ${fileName}` }),
      );

      expect(errors).toEqual([]);
      const agentRules = rules.filter((r) => r.source === "agentFile");
      expect(agentRules).toHaveLength(1);
      expect(agentRules[0].sourceFile).toBe(uri);
      expect(agentRules[0].alwaysApply).toBe(true);
      expect(agentRules[0].rule).toContain(`Content of ${fileName}`);
    },
  );

  it("loads only the first agent file in lookup order", async () => {
    const { rules } = await loadMarkdownRules(
      createIde({
        [`${WORKSPACE}/CLAUDE.md`]: "claude content",
        [`${WORKSPACE}/AGENTS.md`]: "agents content",
      }),
    );

    const agentRules = rules.filter((r) => r.source === "agentFile");
    expect(agentRules.map((r) => r.sourceFile)).toEqual([
      `${WORKSPACE}/AGENTS.md`,
    ]);
  });

  it("uses the agent file from the first workspace that has one", async () => {
    const { rules } = await loadMarkdownRules(
      createIde(
        {
          "file:///second/CLAUDE.md": "second content",
          "file:///third/AGENTS.md": "third content",
        },
        ["file:///first", "file:///second", "file:///third"],
      ),
    );

    const agentRules = rules.filter((r) => r.source === "agentFile");
    expect(agentRules.map((r) => r.sourceFile)).toEqual([
      "file:///second/CLAUDE.md",
    ]);
  });

  it("still loads .continue/rules when there is no agent file", async () => {
    vi.mocked(getAllDotContinueDefinitionFiles).mockImplementation(
      async (_ide, _options, dirName) =>
        dirName === "rules"
          ? [
              {
                path: `${WORKSPACE}/.continue/rules/style.md`,
                content: "# Style\nUse tabs",
              },
            ]
          : [],
    );

    const { rules, errors } = await loadMarkdownRules(createIde({}));

    expect(errors).toEqual([]);
    expect(rules.filter((r) => r.source === "agentFile")).toEqual([]);
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe("rules-block");
    expect(rules[0].sourceFile).toBe(`${WORKSPACE}/.continue/rules/style.md`);
  });
});
