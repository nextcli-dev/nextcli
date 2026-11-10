import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDE } from "../..";
import { getAllDotContinueDefinitionFiles } from "../loadLocalAssistants";
import { findProjectAgentFile, loadMarkdownRules } from "./loadMarkdownRules";

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

  it("follows AGENT.md over CLAUDE.md over CODEX.md", async () => {
    const files: Record<string, string> = {
      [`${WORKSPACE}/AGENT.md`]: "agent",
      [`${WORKSPACE}/CLAUDE.md`]: "claude",
      [`${WORKSPACE}/CODEX.md`]: "codex",
    };
    const loaded: string[] = [];
    for (const next of ["AGENT.md", "CLAUDE.md", "CODEX.md"]) {
      const { rules } = await loadMarkdownRules(createIde(files));
      loaded.push(
        ...rules
          .filter((r) => r.source === "agentFile")
          .map((r) => r.sourceFile!),
      );
      delete files[`${WORKSPACE}/${next}`];
    }

    expect(loaded).toEqual([
      `${WORKSPACE}/AGENT.md`,
      `${WORKSPACE}/CLAUDE.md`,
      `${WORKSPACE}/CODEX.md`,
    ]);
  });

  it("reports an unreadable agent file and does not fall back to the next name", async () => {
    const ide = createIde({ [`${WORKSPACE}/CLAUDE.md`]: "claude" });
    vi.mocked(ide.fileExists).mockImplementation(
      async (uri: string) =>
        uri === `${WORKSPACE}/AGENTS.md` || uri === `${WORKSPACE}/CLAUDE.md`,
    );

    const { rules, errors } = await loadMarkdownRules(ide);

    expect(rules.filter((r) => r.source === "agentFile")).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].fatal).toBe(false);
    expect(errors[0].message).toContain(`${WORKSPACE}/AGENTS.md`);
  });

  it("ignores later workspaces once an earlier one has an agent file", async () => {
    const { rules } = await loadMarkdownRules(
      createIde(
        {
          "file:///first/CODEX.md": "first content",
          "file:///second/AGENTS.md": "second content",
        },
        ["file:///first", "file:///second"],
      ),
    );

    expect(
      rules.filter((r) => r.source === "agentFile").map((r) => r.sourceFile),
    ).toEqual(["file:///first/CODEX.md"]);
  });

  it("finds the same file the loader loads", async () => {
    const ide = createIde(
      {
        "file:///second/CLAUDE.md": "second content",
        "file:///second/CODEX.md": "codex content",
      },
      ["file:///first", "file:///second"],
    );

    expect(await findProjectAgentFile(ide)).toEqual({
      uri: "file:///second/CLAUDE.md",
      workspaceDir: "file:///second",
    });
    expect(await findProjectAgentFile(createIde({}))).toBeUndefined();
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
