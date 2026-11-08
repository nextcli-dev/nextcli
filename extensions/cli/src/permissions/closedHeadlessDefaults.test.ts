import { describe, expect, it } from "vitest";

import { ToolPermissionService } from "../services/ToolPermissionService.js";

import { getDefaultToolPolicies } from "./defaultPolicies.js";
import {
  checkToolPermission,
  isAllowedForSomeArguments,
} from "./permissionChecker.js";
import { resolvePermissionPrecedence } from "./precedenceResolver.js";

/** Headless policies as `cn -p` builds them, without ~/.continue/permissions.yaml */
function headlessPolicies(flags?: {
  allow?: string[];
  ask?: string[];
  exclude?: string[];
}) {
  return {
    policies: resolvePermissionPrecedence({
      commandLineFlags: flags,
      personalSettings: false,
      useDefaults: true,
      isHeadless: true,
    }),
  };
}

const bash = (command: string) => ({ name: "Bash", arguments: { command } });

describe("closed headless defaults", () => {
  describe("default policies", () => {
    it("excludes MCP and unknown tools and Fetch, and tags the defaults", () => {
      const policies = getDefaultToolPolicies(true);

      expect(policies).toContainEqual({
        tool: "*",
        permission: "exclude",
        source: "default",
      });
      expect(policies).toContainEqual({
        tool: "Fetch",
        permission: "exclude",
        source: "default",
      });
      expect(policies).toContainEqual({
        tool: "Bash",
        permission: "allow",
        source: "default",
      });
    });

    it("leaves the TUI defaults open to a person", () => {
      const policies = getDefaultToolPolicies(false);

      expect(policies).toContainEqual(
        expect.objectContaining({ tool: "*", permission: "ask" }),
      );
      expect(policies).toContainEqual(
        expect.objectContaining({ tool: "Fetch", permission: "allow" }),
      );
    });
  });

  describe("Bash under the defaults", () => {
    it.each([
      "ls -la",
      "git status",
      "git diff HEAD~1",
      "git log --oneline",
      "cat package.json",
    ])("runs the read-only command %s", (command) => {
      expect(
        checkToolPermission(bash(command), headlessPolicies()).permission,
      ).toBe("allow");
    });

    it.each([
      "cp a.txt b.txt",
      "mv a.txt b.txt",
      "tee out.txt",
      "touch x",
      "curl https://example.com",
      "npm install left-pad",
      "npm test",
      "npm run build",
      "make build",
      "cargo build",
      "tar -cf out.tar .",
      "zip out.zip a.txt",
      "git branch -D feature",
      "git remote add origin https://example.com",
      "git log --output=out.txt",
      "git commit -am x",
      "sed -i 's/a/b/' src/x.ts",
      "python -c 'print(1)'",
      "./script.sh",
      "prettier --write .",
      "echo hi > notes.txt",
      "cat a.txt >> b.txt",
    ])("asks, so refuses, %s", (command) => {
      expect(
        checkToolPermission(bash(command), headlessPolicies()).permission,
      ).toBe("ask");
    });

    it("still excludes commands the evaluator disables", () => {
      expect(
        checkToolPermission(bash("rm -rf /"), headlessPolicies()).permission,
      ).not.toBe("allow");
    });

    it("stays offered to the model, because it is probed without arguments", () => {
      expect(
        checkToolPermission({ name: "Bash", arguments: {} }, headlessPolicies())
          .permission,
      ).toBe("allow");
    });
  });

  describe("--allow opt-in", () => {
    it("lets --allow Bash run what the defaults refuse", () => {
      const permissions = headlessPolicies({ allow: ["Bash"] });
      expect(checkToolPermission(bash("cp a b"), permissions).permission).toBe(
        "allow",
      );
      expect(
        checkToolPermission(bash("npm install left-pad"), permissions)
          .permission,
      ).toBe("allow");
    });

    it("lets --allow with a command glob run only matching commands", () => {
      const permissions = headlessPolicies({ allow: ["Bash(npm test*)"] });
      expect(
        checkToolPermission(bash("npm test -- --run"), permissions).permission,
      ).toBe("allow");
      expect(
        checkToolPermission(bash("curl https://example.com"), permissions)
          .permission,
      ).toBe("ask");
    });

    it("keeps the destructive-command guard under --allow Bash", () => {
      expect(
        checkToolPermission(
          bash("rm -rf /opt"),
          headlessPolicies({ allow: ["Bash"] }),
        ).permission,
      ).toBe("ask");
    });

    it("offers Fetch only with --allow Fetch", () => {
      const probe = { name: "Fetch", arguments: {} };
      expect(checkToolPermission(probe, headlessPolicies()).permission).toBe(
        "exclude",
      );
      expect(
        checkToolPermission(probe, headlessPolicies({ allow: ["Fetch"] }))
          .permission,
      ).toBe("allow");
    });

    it("offers an MCP tool only by name, by glob, or with --allow '*'", () => {
      const probe = { name: "github_create_issue", arguments: {} };
      expect(checkToolPermission(probe, headlessPolicies()).permission).toBe(
        "exclude",
      );
      expect(
        checkToolPermission(
          probe,
          headlessPolicies({ allow: ["github_create_issue"] }),
        ).permission,
      ).toBe("allow");
      expect(
        checkToolPermission(probe, headlessPolicies({ allow: ["github_*"] }))
          .permission,
      ).toBe("allow");
      expect(
        checkToolPermission(probe, headlessPolicies({ allow: ["*"] }))
          .permission,
      ).toBe("allow");
    });
  });

  describe("--readonly with --allow", () => {
    function readOnly(flags: {
      allow?: string[];
      ask?: string[];
      exclude?: string[];
    }) {
      const service = new ToolPermissionService();
      service.initializeSync({ ...flags, mode: "plan", isHeadless: true });
      return service.getPermissions();
    }

    it("does not let a scoped Bash allow run a different command or a chain", () => {
      const permissions = readOnly({ allow: ["Bash(ls*)"] });
      expect(checkToolPermission(bash("ls -la"), permissions).permission).toBe(
        "allow",
      );
      expect(
        checkToolPermission(bash("cp a.txt b.txt"), permissions).permission,
      ).toBe("exclude");
      expect(
        checkToolPermission(bash("ls; cp a.txt b.txt"), permissions).permission,
      ).toBe("exclude");
    });

    it("offers a tool a check asked for", () => {
      const permissions = readOnly({ allow: ["Bash(git log*)"] });
      expect(
        checkToolPermission(bash("git log --oneline"), permissions).permission,
      ).toBe("allow");
      expect(
        checkToolPermission(bash("curl https://example.com"), permissions)
          .permission,
      ).toBe("exclude");
    });

    it.each([["Write"], ["Edit"], ["MultiEdit"], ["*"]])(
      "never lets --allow %s write files",
      (tool) => {
        const permissions = readOnly({ allow: [tool] });
        for (const name of ["Write", "Edit", "MultiEdit"]) {
          expect(
            checkToolPermission({ name, arguments: {} }, permissions)
              .permission,
          ).toBe("exclude");
        }
      },
    );

    it("drops --ask when nobody is watching", () => {
      const permissions = readOnly({ ask: ["Read"] });
      expect(
        checkToolPermission({ name: "Read", arguments: {} }, permissions)
          .permission,
      ).toBe("allow");
    });

    it("applies --exclude", () => {
      expect(
        checkToolPermission(
          { name: "Read", arguments: {} },
          readOnly({ exclude: ["Read"] }),
        ).permission,
      ).toBe("exclude");
    });

    it.each([
      "Bash",
      "Fetch",
      "*",
      "Bash(*)",
      "Fetch(*)",
      "Bash*",
      "Fetch*",
      "Bash(**)",
      "**",
      "*sh",
    ])(
      "does not let --allow %s reopen the shell, Fetch or MCP tools",
      (tool) => {
        const permissions = readOnly({ allow: [tool] });
        expect(
          checkToolPermission(bash("cp a.txt b.txt"), permissions).permission,
        ).toBe("exclude");
        expect(
          checkToolPermission(bash("curl https://example.com"), permissions)
            .permission,
        ).toBe("exclude");
        expect(
          checkToolPermission({ name: "Fetch", arguments: {} }, permissions)
            .permission,
        ).toBe("exclude");
        expect(
          checkToolPermission(
            { name: "github_create_issue", arguments: {} },
            permissions,
          ).permission,
        ).toBe("exclude");
      },
    );

    it("still opts in to one MCP server with a scoped --allow", () => {
      const permissions = readOnly({ allow: ["github_*"] });
      expect(
        checkToolPermission(
          { name: "github_create_issue", arguments: {} },
          permissions,
        ).permission,
      ).toBe("allow");
      expect(
        checkToolPermission(bash("cp a.txt b.txt"), permissions).permission,
      ).toBe("exclude");
    });
  });
  describe("the cn review worker", () => {
    // reviewWorker.ts: headless, allow the three write tools, nothing else
    const worker = () =>
      headlessPolicies({ allow: ["Edit", "MultiEdit", "Write"] });

    it("can edit the files it reviews", () => {
      for (const name of ["Edit", "MultiEdit", "Write"]) {
        expect(
          checkToolPermission({ name, arguments: {} }, worker()).permission,
        ).toBe("allow");
      }
      expect(
        checkToolPermission({ name: "Read", arguments: {} }, worker())
          .permission,
      ).toBe("allow");
    });

    it("gets no MCP tools, no Fetch and no shell commands beyond read-only ones", () => {
      expect(
        checkToolPermission(
          { name: "github_create_issue", arguments: {} },
          worker(),
        ).permission,
      ).toBe("exclude");
      expect(
        checkToolPermission({ name: "Fetch", arguments: {} }, worker())
          .permission,
      ).toBe("exclude");
      expect(
        checkToolPermission(bash("curl https://example.com"), worker())
          .permission,
      ).toBe("ask");
      expect(checkToolPermission(bash("git diff"), worker()).permission).toBe(
        "allow",
      );
    });
  });
  describe("Bash(pattern) allows", () => {
    it.each([
      "git log; curl https://evil.example",
      "git log && curl https://evil.example",
      "git log | tee out.txt",
      "git log > out.txt",
      "git log $(curl https://evil.example)",
      "git log & curl https://evil.example",
      "git log `curl https://evil.example`",
      "git log\ncurl https://evil.example",
    ])("does not let %s ride on --allow 'Bash(git log*)'", (command) => {
      const permissions = headlessPolicies({ allow: ["Bash(git log*)"] });
      expect(
        checkToolPermission(bash(command), permissions).permission,
      ).not.toBe("allow");
    });

    it("still allows the simple command the pattern names", () => {
      const permissions = headlessPolicies({ allow: ["Bash(git log*)"] });
      expect(
        checkToolPermission(bash("git log --oneline -5"), permissions)
          .permission,
      ).toBe("allow");
    });

    it("still lets --exclude 'Bash(npm install*)' block a chained command", () => {
      const permissions = headlessPolicies({
        allow: ["Bash"],
        exclude: ["Bash(npm install*)"],
      });
      expect(
        checkToolPermission(bash("npm install left-pad"), permissions)
          .permission,
      ).toBe("exclude");
    });
  });

  describe("offering a tool that is allowed only for some arguments", () => {
    it("offers Bash for --readonly --allow 'Bash(git log*)', and only then", () => {
      const service = new ToolPermissionService();
      service.initializeSync({
        allow: ["Bash(git log*)"],
        mode: "plan",
        isHeadless: true,
      });
      const permissions = service.getPermissions();

      expect(isAllowedForSomeArguments("Bash", permissions)).toBe(true);
      expect(isAllowedForSomeArguments("Fetch", permissions)).toBe(false);
      expect(isAllowedForSomeArguments("Read", permissions)).toBe(false);
    });

    it("lets a policy for the whole tool that comes first win", () => {
      const permissions = {
        policies: [
          { tool: "Bash", permission: "exclude" as const },
          { tool: "Bash(git log*)", permission: "allow" as const },
        ],
      };
      expect(isAllowedForSomeArguments("Bash", permissions)).toBe(false);
    });
  });
});
