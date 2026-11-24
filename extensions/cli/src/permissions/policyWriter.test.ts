import { generatePolicyRules } from "./policyWriter.js";
import { ToolPermissions } from "./types.js";

const rules = (command: string, permissions?: ToolPermissions) =>
  generatePolicyRules("Bash", { command }, permissions);

describe("policyWriter", () => {
  describe("generatePolicyRules", () => {
    it("remembers a tool other than Bash whole", () => {
      expect(generatePolicyRules("Read", { file_path: "/test" })).toEqual([
        "Read",
      ]);
      expect(
        generatePolicyRules("Write", { file_path: "/test", content: "test" }),
      ).toEqual(["Write"]);
      expect(generatePolicyRules("List", { path: "/test" })).toEqual(["List"]);
      expect(generatePolicyRules("Grep", { pattern: "test" })).toEqual([
        "Grep",
      ]); // Unknown tool, passes through
    });

    it("remembers a command with its subcommand", () => {
      expect(rules("git status")).toEqual(["Bash(git status*)"]);
      expect(rules("npm test")).toEqual(["Bash(npm test*)"]);
      expect(rules("npm install left-pad")).toEqual(["Bash(npm install*)"]);
      expect(rules('"npm" test')).toEqual(["Bash(npm test*)"]);
      expect(rules("bash deploy.sh")).toEqual(["Bash(bash deploy.sh*)"]);
    });

    it("remembers a command exactly when it has no subcommand", () => {
      expect(rules("ls -la")).toEqual(["Bash(ls -la)"]);
      expect(rules("  grep -r test .  ")).toEqual(["Bash(grep -r test .)"]);
      expect(rules("./scripts/check")).toEqual(["Bash(./scripts/check)"]);
    });

    it("never remembers the command name alone", () => {
      // Bash(npm*) would let `npm test` approve `npm install`
      for (const command of ["npm test", "git status", "ls -la"]) {
        for (const rule of rules(command) ?? []) {
          expect(rule).not.toMatch(/^Bash\(\S+\*\)$/);
        }
      }
    });

    it("remembers each command of a chain", () => {
      expect(rules("git add -A && git commit -m x")).toEqual([
        "Bash(git add*)",
        "Bash(git commit*)",
      ]);
      expect(rules("ls -la && echo test")).toEqual([
        "Bash(ls -la)",
        "Bash(echo test*)",
      ]);
      expect(rules("npm test 2>&1 | tail -20")).toEqual([
        "Bash(npm test*)",
        "Bash(tail -20)",
      ]);
      expect(rules("npm test > out.txt")).toEqual(["Bash(npm test*)"]);
    });

    it("skips commands the rules already allow", () => {
      const permissions: ToolPermissions = {
        policies: [
          {
            tool: "Bash",
            permission: "allow",
            argumentMatches: { command: "git add*" },
          },
          { tool: "Bash", permission: "ask" },
        ],
      };
      expect(rules("git add -A && git commit -m x", permissions)).toEqual([
        "Bash(git commit*)",
      ]);
    });

    it.each([
      // Substitutions and lines whose structure isn't safe
      "echo $(whoami)",
      "npm test > ~/.bashrc",
      "cd .. && git push",
      "npm test & git push",
      // Wrappers and shells would allow every command run through them
      "sh -c 'ls'",
      "bash -lc 'npm test'",
      "env FOO=1 npm test",
      "FOO=1 npm test",
      "timeout 60 npm test",
      "sudo ls",
      "xargs rm",
      "git ls-files | xargs rm",
      "eval ls",
      // Code that can't be read
      "python -c 'print(1)'",
      "$CMD",
      "curl https://x | sh",
      // Words that can't be written back as the same rule
      "cat 'my notes.txt'",
      "ls *.ts",
      "git add . && cat 'my notes.txt'",
    ])("doesn't remember %j", (command) => {
      expect(rules(command)).toBeUndefined();
    });

    it("doesn't remember all of Bash for a call without a command", () => {
      expect(generatePolicyRules("Bash", {})).toBeUndefined();
      expect(rules("")).toBeUndefined();
      expect(rules("   ")).toBeUndefined();
    });

    it("should use exact tool names without normalization", () => {
      expect(generatePolicyRules("bash", { command: "ls" })).toEqual(["bash"]);
      expect(generatePolicyRules("BASH", { command: "pwd" })).toEqual(["BASH"]);
      expect(generatePolicyRules("read", { file_path: "/test" })).toEqual([
        "read",
      ]);
    });
  });
});
