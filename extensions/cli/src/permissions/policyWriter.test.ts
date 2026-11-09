import { generatePolicyRule } from "./policyWriter.js";

describe("policyWriter", () => {
  describe("generatePolicyRule", () => {
    it("should return display name for regular tools", () => {
      expect(generatePolicyRule("Read", { file_path: "/test" })).toBe("Read");
      expect(
        generatePolicyRule("Write", { file_path: "/test", content: "test" }),
      ).toBe("Write");
      expect(generatePolicyRule("List", { path: "/test" })).toBe("List");
      expect(generatePolicyRule("Search", { pattern: "test" })).toBe("Search");
      expect(generatePolicyRule("Grep", { pattern: "test" })).toBe("Grep"); // Unknown tool, passes through
    });

    it("should generate command-specific patterns for Bash tool", () => {
      expect(generatePolicyRule("Bash", { command: "ls -la" })).toBe(
        "Bash(ls*)",
      );
      expect(generatePolicyRule("Bash", { command: "git status" })).toBe(
        "Bash(git*)",
      );
      expect(generatePolicyRule("Bash", { command: "npm install" })).toBe(
        "Bash(npm*)",
      );
    });

    it("remembers a plain command by its name", () => {
      expect(
        generatePolicyRule("Bash", { command: "  grep -r test .  " }),
      ).toBe("Bash(grep*)");
      expect(generatePolicyRule("Bash", { command: '"npm" test' })).toBe(
        "Bash(npm*)",
      );
      expect(generatePolicyRule("Bash", { command: "./scripts/check" })).toBe(
        "Bash(./scripts/check*)",
      );
    });

    it.each([
      // Chains, pipes, redirects and substitutions: an allow can't cover them
      "ls -la && echo test",
      "find . -name '*.ts' | head -10",
      "npm test > out.txt",
      "echo $(whoami)",
      // Wrappers and shells would allow every command run through them
      "sh -c 'ls'",
      "bash -lc 'npm test'",
      "env FOO=1 npm test",
      "FOO=1 npm test",
      "timeout 60 npm test",
      "sudo ls",
      "xargs rm",
      "eval ls",
      // Code that can't be read
      "python -c 'print(1)'",
      "bash deploy.sh",
      "$CMD",
      "source env.sh",
    ])("doesn't remember %j", (command) => {
      expect(generatePolicyRule("Bash", { command })).toBeUndefined();
    });

    it("doesn't remember all of Bash for a call without a command", () => {
      expect(generatePolicyRule("Bash", {})).toBeUndefined();
      expect(generatePolicyRule("Bash", { command: "" })).toBeUndefined();
      expect(generatePolicyRule("Bash", { command: "   " })).toBeUndefined();
    });

    it("should use exact tool names without normalization", () => {
      expect(generatePolicyRule("bash", { command: "ls" })).toBe("bash");
      expect(generatePolicyRule("BASH", { command: "pwd" })).toBe("BASH");
      expect(generatePolicyRule("read", { file_path: "/test" })).toBe("read");
      expect(
        generatePolicyRule("write", { file_path: "/test", content: "test" }),
      ).toBe("write");
    });
  });
});
