import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

// Use the actual implementation instead of the mocked one
vi.unmock("./systemMessage.js");
const {
  constructSystemMessage,
  constructSystemMessageParts,
  loadMarkdownRulesWithMetadata,
} = await import("./systemMessage.js");
const { env } = await import("./env.js");

// Mock the service container to avoid "No factory registered for service 'config'" error
vi.mock("./services/ServiceContainer.js", () => ({
  serviceContainer: {
    get: vi.fn().mockResolvedValue({ config: { rules: [] } }),
    set: vi.fn(),
  },
}));

// Mock processRule to avoid file system operations in tests
vi.mock("./hubLoader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hubLoader.js")>();
  return {
    ...actual,
    processRule: vi
      .fn()
      .mockImplementation((spec: string) => Promise.resolve(spec)),
  };
});

const PLAN_MODE_STRING = "You are operating in _Plan Mode_";

describe("constructSystemMessage", () => {
  it("labels the agent file and each rule, and joins to the same string", async () => {
    const rules = ["rule-from-the-flag.md"];
    const [message, parts] = await Promise.all([
      constructSystemMessage("normal", rules),
      constructSystemMessageParts("normal", rules),
    ]);
    expect(parts.map((part) => part.text).join("")).toBe(message);
    expect(parts.map((part) => part.label)).toEqual(
      expect.arrayContaining(["AGENTS.md", "rule-from-the-flag.md"]),
    );
  });

  it("does not use inline --rule text as a part label", async () => {
    const text = "Always mention the secret project name Aurora";
    const parts = await constructSystemMessageParts("normal", [text]);
    const message = parts.map((part) => part.text).join("");
    expect(message).toContain(text);
    expect(parts.map((part) => part.label)).toContain("Inline rule");
    expect(parts.map((part) => part.label)).not.toContain(text);
  });

  it("should return base system message with rules when additionalRules is provided", async () => {
    const rules = ["These are the rules for the assistant."];
    const result = await constructSystemMessage("normal", rules);

    expect(result).toContain("You are an agent in the NextCLI CLI");
    expect(result).toContain('<context name="userRules">');
    expect(result).toContain(rules[0]);
    expect(result).toContain("</context>");
  });

  it("should return base system message with agent content when no rules but agent file exists", async () => {
    // The implementation checks for agent files like AGENTS.md which exists in this project
    const result = await constructSystemMessage("normal");

    expect(result).toContain("You are an agent in the NextCLI CLI");
    expect(result).toContain('<context name="userRules">');
    expect(result).toContain("AGENTS.md");
  });

  it("should include base system message components", async () => {
    const result = await constructSystemMessage("normal");

    expect(result).toContain("You are an agent in the NextCLI CLI");
    expect(result).toContain("<env>");
    expect(result).toContain('<context name="gitStatus">');
  });

  it("should handle whitespace-only rules message", async () => {
    const result = await constructSystemMessage("normal", ["   "]);

    expect(result).toContain("You are an agent in the NextCLI CLI");
    expect(result).toContain('<context name="userRules">');
  });

  it("should include working directory information", async () => {
    const result = await constructSystemMessage("normal");

    expect(result).toContain("Working directory:");
    expect(result).toContain("<env>");
  });

  it("should include platform information", async () => {
    const result = await constructSystemMessage("normal");

    expect(result).toContain("Platform:");
  });

  it("should include current date", async () => {
    const result = await constructSystemMessage("normal");

    expect(result).toContain("Today's date:");
    expect(result).toContain(new Date().toISOString().split("T")[0]);
  });

  it("should format rules section correctly", async () => {
    const rulesMessage = "Rule 1: Do this\nRule 2: Do that";
    const result = await constructSystemMessage("normal", [rulesMessage]);

    expect(result).toContain('<context name="userRules">');
    expect(result).toContain(rulesMessage);
    expect(result).toContain("</context>");
  });

  it("should handle multiline rules message", async () => {
    const rulesMessage = `Rule 1: First rule
Rule 2: Second rule
Rule 3: Third rule`;
    const result = await constructSystemMessage("normal", [rulesMessage]);

    expect(result).toContain(rulesMessage);
    expect(result).toContain('<context name="userRules">');
    expect(result).toContain("</context>");
  });

  it("should handle special characters in rules message", async () => {
    const rulesMessage = "Rule with <special> characters & symbols!";
    const result = await constructSystemMessage("normal", [rulesMessage]);

    expect(result).toContain(rulesMessage);
    expect(result).toContain('<context name="userRules">');
  });

  it("should handle very long rules message", async () => {
    const rulesMessage = "A".repeat(1000);
    const result = await constructSystemMessage("normal", [rulesMessage]);

    expect(result).toContain(rulesMessage);
    expect(result).toContain('<context name="userRules">');
  });

  it("should combine rules and agent content when both are present", async () => {
    const rulesMessage = "These are the rules.";
    const result = await constructSystemMessage("normal", [rulesMessage]);

    expect(result).toContain('<context name="userRules">');
    expect(result).toContain(rulesMessage);
    expect(result).toContain("AGENTS.md");
    expect(result).toContain("</context>");
  });

  it("should add headless mode instructions when headless is true", async () => {
    const result = await constructSystemMessage(
      "normal",
      undefined,
      undefined,
      true,
    );

    expect(result).toContain("You are an agent in the NextCLI CLI");
    expect(result).toContain("IMPORTANT: You are running in headless mode");
    expect(result).toContain("Provide ONLY your final answer");
    expect(result).toContain(
      "Do not include explanations, reasoning, or additional commentary",
    );
  });

  it("should not add headless mode instructions when headless is false", async () => {
    const result = await constructSystemMessage(
      "normal",
      undefined,
      undefined,
      false,
    );

    expect(result).toContain("You are an agent in the NextCLI CLI");
    expect(result).not.toContain("IMPORTANT: You are running in headless mode");
    expect(result).not.toContain("Provide ONLY your final answer");
  });

  it("should not add headless mode instructions when headless is undefined", async () => {
    const result = await constructSystemMessage("normal");

    expect(result).toContain("You are an agent in the NextCLI CLI");
    expect(result).not.toContain("IMPORTANT: You are running in headless mode");
    expect(result).not.toContain("Provide ONLY your final answer");
  });

  it("should add JSON format instructions when format is json", async () => {
    const result = await constructSystemMessage("normal", undefined, "json");

    expect(result).toContain("You are an agent in the NextCLI CLI");
    expect(result).toContain(
      "IMPORTANT: You are operating in JSON output mode",
    );
    expect(result).toContain("Your final response MUST be valid JSON");
    expect(result).toContain("JSON.parse()");
  });

  it("should add plan mode instructions when mode is plan", async () => {
    const result = await constructSystemMessage(
      "plan",
      undefined,
      undefined,
      false,
    );

    expect(result).toContain("You are an agent in the NextCLI CLI");
    expect(result).toContain(PLAN_MODE_STRING);
    expect(result).toContain(
      "which means that your goal is to help the user investigate their ideas",
    );
    expect(result).toContain("develop a plan before taking action");
    expect(result).toContain("read-only tools");
    expect(result).toContain(
      "should not attempt to circumvent them to write / delete / create files",
    );
  });

  it("should not add plan mode instructions when mode is not plan", async () => {
    const result = await constructSystemMessage(
      "normal",
      undefined,
      undefined,
      false,
    );

    expect(result).toContain("You are an agent in the NextCLI CLI");
    expect(result).not.toContain(PLAN_MODE_STRING);
    expect(result).not.toContain(
      "which means that your goal is to help the user investigate their ideas",
    );
  });

  it("should not add plan mode instructions when mode is normal", async () => {
    const result = await constructSystemMessage("normal");

    expect(result).toContain("You are an agent in the NextCLI CLI");
    expect(result).not.toContain(PLAN_MODE_STRING);
    expect(result).not.toContain(
      "which means that your goal is to help the user investigate their ideas",
    );
  });

  it("should include basic plan mode description", async () => {
    const result = await constructSystemMessage(
      "plan",
      undefined,
      undefined,
      false,
    );

    expect(result).toContain(PLAN_MODE_STRING);
    expect(result).toContain("read-only tools");
    expect(result).toContain("write / delete / create files");
  });

  it("should combine plan mode with headless mode instructions", async () => {
    const result = await constructSystemMessage(
      "plan",
      undefined,
      undefined,
      true,
    );

    expect(result).toContain("IMPORTANT: You are running in headless mode");
    expect(result).toContain(PLAN_MODE_STRING);
    expect(result).toContain(
      "which means that your goal is to help the user investigate their ideas",
    );
  });

  it("should combine plan mode with JSON format instructions", async () => {
    const result = await constructSystemMessage(
      "plan",
      undefined,
      "json",
      false,
    );

    expect(result).toContain(
      "IMPORTANT: You are operating in JSON output mode",
    );
    expect(result).toContain(PLAN_MODE_STRING);
    expect(result).toContain(
      "which means that your goal is to help the user investigate their ideas",
    );
  });

  describe("project agent file", () => {
    let dir: string | undefined;
    const spies: { mockRestore: () => void }[] = [];

    function useWorkingDirectory(files: Record<string, string>) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-system-message-"));
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content);
      }
      spies.push(vi.spyOn(process, "cwd").mockReturnValue(dir));
      return dir;
    }

    afterEach(() => {
      spies.splice(0).forEach((spy) => spy.mockRestore());
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
        dir = undefined;
      }
    });

    it("loads CODEX.md when it is the only agent file", async () => {
      useWorkingDirectory({ "CODEX.md": "codex-only-guidance" });

      const result = await constructSystemMessage("normal");

      expect(result).toContain("codex-only-guidance");
    });

    it("does not fall back to CLAUDE.md when AGENTS.md can't be read", async () => {
      const cwd = useWorkingDirectory({ "CLAUDE.md": "claude-guidance" });
      // A directory passes the existence check but fails to read.
      fs.mkdirSync(path.join(cwd, "AGENTS.md"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      spies.push(warn);

      const result = await constructSystemMessage("normal");

      expect(result).not.toContain("claude-guidance");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(path.join(cwd, "AGENTS.md")),
        expect.anything(),
      );
    });
  });

  describe("rules from .claude/rules", () => {
    let dir: string | undefined;
    const originalHome = env.continueHome;
    const spies: { mockRestore: () => void }[] = [];

    function useRules(files: Record<string, string>) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-claude-rules-"));
      for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), content);
      }
      // Keep the person's own ~/.continue/rules out of the result
      env.continueHome = path.join(dir, "home");
      spies.push(vi.spyOn(process, "cwd").mockReturnValue(dir));
      return dir;
    }

    afterEach(() => {
      spies.splice(0).forEach((spy) => spy.mockRestore());
      env.continueHome = originalHome;
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
        dir = undefined;
      }
    });

    it("applies a .claude/rules rule without paths in every session", async () => {
      useRules({ ".claude/rules/style.md": "# Style\n\nclaude-always-rule" });

      const result = await constructSystemMessage("normal");

      expect(result).toContain("claude-always-rule");
    });

    // As documented: cn loads only rules without paths or globs, from
    // .claude/rules and .continue/rules alike
    it("leaves out a .claude/rules rule scoped with paths:, as it does any scoped rule", async () => {
      useRules({
        ".claude/rules/tests.md":
          '---\npaths:\n  - "**/*.test.ts"\n---\n\nclaude-scoped-rule',
        ".claude/rules/style.md": "# Style\n\nclaude-always-rule",
      });

      const result = await constructSystemMessage("normal");

      expect(result).toContain("claude-always-rule");
      expect(result).not.toContain("claude-scoped-rule");
    });

    it("loads a .claude/rules symlink to a .continue/rules file once", () => {
      const cwd = useRules({
        ".continue/rules/shared.md": "# Shared\n\nshared-rule",
      });
      fs.mkdirSync(path.join(cwd, ".claude", "rules"), { recursive: true });
      fs.symlinkSync(
        path.join(cwd, ".continue", "rules", "shared.md"),
        path.join(cwd, ".claude", "rules", "shared.md"),
      );

      const rules = loadMarkdownRulesWithMetadata();

      expect(rules.filter((r) => r.rule.includes("shared-rule"))).toHaveLength(
        1,
      );
    });
  });
});
