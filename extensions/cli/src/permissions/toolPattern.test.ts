import { describe, expect, it } from "vitest";

import { ALL_BUILT_IN_TOOLS } from "../tools/allBuiltIns.js";

import { checkToolPermission } from "./permissionChecker.js";
import {
  commandLineFlagsToPolicies,
  parseToolPattern,
  PATTERN_ARGUMENT,
} from "./toolPattern.js";

describe("parseToolPattern", () => {
  it("parses a tool name or a tool-name glob", () => {
    expect(parseToolPattern("Write", "allow")).toEqual({
      tool: "Write",
      permission: "allow",
    });
    expect(parseToolPattern("github_*", "exclude")).toEqual({
      tool: "github_*",
      permission: "exclude",
    });
  });

  it.each([
    ["Bash(npm install*)", { command: "npm install*" }],
    ["Diff(src/*)", { path: "src/*" }],
    ["Edit(src/*.ts)", { file_path: "src/*.ts" }],
    ["Fetch(https://api.example.com/*)", { url: "https://api.example.com/*" }],
    ["List(src)", { dirpath: "src" }],
    ["MultiEdit(src/*.ts)", { file_path: "src/*.ts" }],
    ["Read(.env*)", { filepath: ".env*" }],
    ["Search(TODO)", { pattern: "TODO" }],
    ["Write(src/**/*.ts)", { filepath: "src/**/*.ts" }],
  ])("matches %s against the tool's argument", (pattern, argumentMatches) => {
    expect(parseToolPattern(pattern, "allow").argumentMatches).toEqual(
      argumentMatches,
    );
  });

  it("names arguments every built-in tool really takes", () => {
    for (const [toolName, argument] of Object.entries(PATTERN_ARGUMENT)) {
      const tool = ALL_BUILT_IN_TOOLS.find((t) => t.name === toolName);
      expect(tool, toolName).toBeDefined();
      expect(Object.keys(tool!.parameters.properties ?? {})).toContain(
        argument,
      );
    }
  });

  it("trims and keeps parentheses inside the pattern", () => {
    expect(parseToolPattern("Bash( npm run test )", "ask")).toEqual({
      tool: "Bash",
      permission: "ask",
      argumentMatches: { command: "npm run test" },
    });
    expect(parseToolPattern("Bash(echo (x)*)", "ask").argumentMatches).toEqual({
      command: "echo (x)*",
    });
  });

  it("treats empty parentheses as the whole tool", () => {
    expect(parseToolPattern("Write()", "allow")).toEqual({
      tool: "Write",
      permission: "allow",
    });
  });

  it.each([
    ["Write(unclosed", /Invalid tool pattern: Write\(unclosed/],
    ["(x)", /Invalid tool pattern/],
    ["", /empty/],
    // An exclude that silently matched nothing would leave the tool open
    ["github_create_issue(x)", /has no argument a pattern can match/],
    ["write(**/*.ts)", /has no argument a pattern can match/],
  ])("rejects %j", (pattern, message) => {
    expect(() => parseToolPattern(pattern, "exclude")).toThrow(message);
  });
});

describe("commandLineFlagsToPolicies", () => {
  it("orders excludes, then asks, then allows", () => {
    expect(
      commandLineFlagsToPolicies({
        allow: ["Read"],
        ask: ["Write"],
        exclude: ["Bash(rm*)"],
      }),
    ).toEqual([
      {
        tool: "Bash",
        permission: "exclude",
        argumentMatches: { command: "rm*" },
      },
      { tool: "Write", permission: "ask" },
      { tool: "Read", permission: "allow" },
    ]);
  });

  it("makes a scoped flag match the tool's real argument", () => {
    const permissions = {
      policies: [
        ...commandLineFlagsToPolicies({ exclude: ["Read(.env*)"] }),
        { tool: "Read", permission: "allow" as const },
      ],
    };
    const read = (filepath: string) =>
      checkToolPermission(
        { name: "Read", arguments: { filepath } },
        permissions,
      ).permission;
    expect(read(".env")).toBe("exclude");
    expect(read("src/index.ts")).toBe("allow");
  });
});
