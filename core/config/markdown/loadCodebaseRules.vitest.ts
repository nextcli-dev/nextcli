import * as configYaml from "@nextcli/config-yaml";
import { markdownToRule } from "@nextcli/config-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDE } from "../..";
import { walkDirs } from "../../indexing/walkDir";
import { CodebaseRulesCache, loadCodebaseRules } from "./loadCodebaseRules";

// Mock dependencies
vi.mock("../../indexing/walkDir", () => ({
  walkDirs: vi.fn(),
}));

vi.mock("@nextcli/config-yaml", async (importOriginal) => {
  const actual = await importOriginal<typeof configYaml>();
  return {
    markdownToRule: vi.fn(),
    parseMarkdownRule: actual.parseMarkdownRule,
  };
});

describe("loadCodebaseRules", () => {
  // Mock IDE with properly typed mock functions
  const mockIde = {
    fileExists: vi.fn().mockImplementation(() => true),
    readFile: vi.fn() as unknown as IDE["readFile"] & {
      mockImplementation: Function;
    },
    getWorkspaceDirs: vi.fn() as unknown as IDE["getWorkspaceDirs"] & {
      mockImplementation: Function;
    },
  } as unknown as IDE;

  // Mock rule content
  const mockRuleContent: Record<string, string> = {
    "file:///workspace/src/rules.md":
      "# General Rules\nFollow coding standards",
    "file:///workspace/src/redux/rules.md":
      '---\nglobs: "**/*.{ts,tsx}"\n---\n# Redux Rules\nUse Redux Toolkit',
    "file:///workspace/src/components/rules.md":
      '---\nglobs: ["**/*.tsx", "**/*.jsx"]\n---\n# Component Rules\nUse functional components',
    "file:///workspace/.continue/rules.md":
      "# Global Rules\nFollow project guidelines",
  };

  // Mock converted rules
  const mockConvertedRules: Record<string, any> = {
    "file:///workspace/src/rules.md": {
      name: "src/rules.md",
      rule: "Follow coding standards",
      source: "colocated-markdown",
      sourceFile: "file:///workspace/src/rules.md",
    },
    "file:///workspace/src/redux/rules.md": {
      name: "src/redux/rules.md",
      rule: "Use Redux Toolkit",
      globs: "**/*.{ts,tsx}",
      source: "colocated-markdown",
      sourceFile: "file:///workspace/src/redux/rules.md",
    },
    "file:///workspace/src/components/rules.md": {
      name: "src/components/rules.md",
      rule: "Use functional components",
      globs: ["**/*.tsx", "**/*.jsx"],
      source: "colocated-markdown",
      sourceFile: "file:///workspace/src/components/rules.md",
    },
    "file:///workspace/.continue/rules.md": {
      name: ".continue/rules.md",
      rule: "Follow project guidelines",
      source: "colocated-markdown",
      sourceFile: "file:///workspace/.continue/rules.md",
    },
  };

  beforeEach(() => {
    // Setup mocks
    vi.resetAllMocks();

    // Mock walkDirs to return our test files
    (walkDirs as any).mockResolvedValue([
      ...Object.keys(mockRuleContent),
      "file:///workspace/src/utils/helper.ts", // Non-rules file
    ]);

    // Mock getWorkspaceDirs to return a workspace directory
    (mockIde.getWorkspaceDirs as any).mockResolvedValue(["file:///workspace"]);

    // Mock readFile to return content based on path
    (mockIde.readFile as any).mockImplementation((path: string) => {
      return Promise.resolve(mockRuleContent[path] || "");
    });

    // Mock markdownToRule to return converted rules
    (markdownToRule as any).mockImplementation(
      (content: string, options: any) => {
        return mockConvertedRules[options.fileUri];
      },
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
  });
  it("should load rules from all rules.md files in the workspace", async () => {
    const { rules, errors } = await loadCodebaseRules(mockIde);

    // Should find all rules.md files
    expect(walkDirs).toHaveBeenCalledWith(mockIde);

    // Should read all rules.md files
    expect(mockIde.readFile).toHaveBeenCalledTimes(4);
    expect(mockIde.readFile).toHaveBeenCalledWith(
      "file:///workspace/src/rules.md",
    );
    expect(mockIde.readFile).toHaveBeenCalledWith(
      "file:///workspace/src/redux/rules.md",
    );
    expect(mockIde.readFile).toHaveBeenCalledWith(
      "file:///workspace/src/components/rules.md",
    );
    expect(mockIde.readFile).toHaveBeenCalledWith(
      "file:///workspace/.continue/rules.md",
    );

    // Should convert all rules
    expect(markdownToRule).toHaveBeenCalledTimes(4);

    // Should return all rules
    expect(rules).toHaveLength(4);
    expect(rules).toContainEqual(
      mockConvertedRules["file:///workspace/src/rules.md"],
    );
    expect(rules).toContainEqual(
      mockConvertedRules["file:///workspace/src/redux/rules.md"],
    );
    expect(rules).toContainEqual(
      mockConvertedRules["file:///workspace/src/components/rules.md"],
    );
    expect(rules).toContainEqual(
      mockConvertedRules["file:///workspace/.continue/rules.md"],
    );

    // Should not have errors
    expect(errors).toHaveLength(0);
  });

  it("should handle errors when reading a rule file", async () => {
    // Setup mock to throw for a specific file
    (mockIde.readFile as any).mockImplementation((path: string) => {
      if (path === "file:///workspace/src/redux/rules.md") {
        return Promise.reject(new Error("Failed to read file"));
      }
      return Promise.resolve(mockRuleContent[path] || "");
    });

    const { rules, errors } = await loadCodebaseRules(mockIde);

    // Should still return other rules
    expect(rules).toHaveLength(3);
    expect(rules).toContainEqual(
      mockConvertedRules["file:///workspace/src/rules.md"],
    );
    expect(rules).toContainEqual(
      mockConvertedRules["file:///workspace/src/components/rules.md"],
    );
    expect(rules).toContainEqual(
      mockConvertedRules["file:///workspace/.continue/rules.md"],
    );

    // Should have one error
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(
      "Failed to parse colocated rule file file:///workspace/src/redux/rules.md: Failed to read file",
    );
  });

  it("should handle errors when walkDirs fails", async () => {
    // Setup mock to throw
    (walkDirs as any).mockRejectedValue(
      new Error("Failed to walk directories"),
    );
    const { rules, errors } = await loadCodebaseRules(mockIde);

    // Should return no rules
    expect(rules).toHaveLength(0);

    // Should have one error
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Error loading colocated rule files");
  });
  describe("rule names", () => {
    beforeEach(async () => {
      const actual = await vi.importActual<typeof configYaml>(
        "@nextcli/config-yaml",
      );
      (markdownToRule as any).mockImplementation(actual.markdownToRule);
    });

    function setFiles(files: Record<string, string>, dirs: string[]) {
      (walkDirs as any).mockResolvedValue(Object.keys(files));
      (mockIde.getWorkspaceDirs as any).mockResolvedValue(dirs);
      (mockIde.readFile as any).mockImplementation((path: string) =>
        Promise.resolve(files[path] ?? ""),
      );
    }

    it("names rules by workspace-relative path so same-named dirs don't collide", async () => {
      setFiles(
        {
          "file:///root/repo/gui/rules.md": "Repo gui rule",
          "file:///root/repo-worktree/gui/rules.md": "Worktree gui rule",
          "file:///root/repo/packages/a/src/rules.md": "a",
          "file:///root/repo/packages/b/src/rules.md": "b",
        },
        ["file:///root"],
      );

      const { rules, errors } = await loadCodebaseRules(mockIde);

      expect(errors).toHaveLength(0);
      expect(rules.map((r) => r.name).sort()).toEqual([
        "repo-worktree/gui/rules.md",
        "repo/gui/rules.md",
        "repo/packages/a/src/rules.md",
        "repo/packages/b/src/rules.md",
      ]);
      expect(
        rules.find((r) => r.name === "repo/packages/a/src/rules.md")?.globs,
      ).toBe("repo/packages/a/src/**/*");
    });

    it("prefixes the root folder name in a multi-root workspace", async () => {
      setFiles(
        {
          "file:///root/repo/gui/rules.md": "Repo gui rule",
          "file:///root/repo-worktree/gui/rules.md": "Worktree gui rule",
        },
        ["file:///root/repo", "file:///root/repo-worktree"],
      );

      const { rules } = await loadCodebaseRules(mockIde);

      expect(rules.map((r) => r.name).sort()).toEqual([
        "repo-worktree/gui/rules.md",
        "repo/gui/rules.md",
      ]);
    });

    it("keeps a name set in frontmatter", async () => {
      setFiles(
        {
          "file:///root/gui/rules.md":
            "---\nname: GUI conventions\n---\nUse openUrl",
        },
        ["file:///root"],
      );

      const { rules } = await loadCodebaseRules(mockIde);

      expect(rules.map((r) => r.name)).toEqual(["GUI conventions"]);
    });

    it("scopes globs to the rule's directory when a single file is updated", async () => {
      setFiles(
        { "file:///root/gui/rules.md": '---\nglobs: "**/*.tsx"\n---\nRule' },
        ["file:///root"],
      );
      const cache = CodebaseRulesCache.getInstance();
      cache.rules = [];

      await cache.update(mockIde, "file:///root/gui/rules.md");

      expect(cache.rules).toHaveLength(1);
      expect(cache.rules[0].name).toBe("gui/rules.md");
      expect(cache.rules[0].globs).toBe("gui/**/*.tsx");
    });
  });
});
