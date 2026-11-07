import { describe, expect, it } from "vitest";

import {
  getDefaultToolPolicies,
  getPlanModePolicies,
} from "./defaultPolicies.js";
const DEFAULT_TOOL_POLICIES = getDefaultToolPolicies();

describe("defaultPolicies", () => {
  it("should have correct permissions for read-only tools", () => {
    const readOnlyTools = [
      "Read",
      "List",
      "Search",
      "Fetch",
      "Exit",
      "Diff",
      "Checklist",
    ];

    for (const tool of readOnlyTools) {
      const policy = DEFAULT_TOOL_POLICIES.find((p) => p.tool === tool);
      expect(policy, `Policy should exist for ${tool}`).toBeDefined();
      expect(policy?.permission, `${tool} should be allowed`).toBe("allow");
    }
  });

  it("should not have prefix wildcard policies in defaults", () => {
    const prefixWildcardPolicy = DEFAULT_TOOL_POLICIES.find(
      (p) => p.tool.endsWith("*") && p.tool !== "*",
    );
    expect(prefixWildcardPolicy).toBeUndefined();
  });

  it("should have correct permissions for write tools", () => {
    const writeTools = ["Write", "Edit", "MultiEdit", "Bash"];

    for (const tool of writeTools) {
      const policy = DEFAULT_TOOL_POLICIES.find((p) => p.tool === tool);
      expect(policy, `Policy should exist for ${tool}`).toBeDefined();
      expect(policy?.permission, `${tool} should require confirmation`).toBe(
        "ask",
      );
    }
  });

  it("should have a catch-all policy", () => {
    const catchAllPolicy = DEFAULT_TOOL_POLICIES.find((p) => p.tool === "*");
    expect(catchAllPolicy).toBeDefined();
    expect(catchAllPolicy?.permission).toBe("ask");
  });

  it("should include MultiEdit policy", () => {
    const multiEditPolicy = DEFAULT_TOOL_POLICIES.find(
      (p) => p.tool === "MultiEdit",
    );
    expect(multiEditPolicy).toBeDefined();
    expect(multiEditPolicy?.permission).toBe("ask");
  });

  it("should have policies in correct order", () => {
    // The catch-all policy should be last
    const catchAllIndex = DEFAULT_TOOL_POLICIES.findIndex(
      (p) => p.tool === "*",
    );
    expect(catchAllIndex).toBe(DEFAULT_TOOL_POLICIES.length - 1);
  });
});

describe("plan mode policies", () => {
  it("asks before Bash and MCP tools in the TUI and allows Fetch", () => {
    const policies = getPlanModePolicies(false);

    expect(policies).toContainEqual({ tool: "Edit", permission: "exclude" });
    expect(policies).toContainEqual({
      tool: "MultiEdit",
      permission: "exclude",
    });
    expect(policies).toContainEqual({ tool: "Write", permission: "exclude" });
    expect(policies).toContainEqual({ tool: "Bash", permission: "ask" });
    expect(policies).toContainEqual({ tool: "Fetch", permission: "allow" });
    expect(policies).toContainEqual({ tool: "*", permission: "ask" });
    expect(policies).toContainEqual({ tool: "Read", permission: "allow" });
  });

  it("excludes Bash, Fetch and MCP tools when nobody is watching", () => {
    const policies = getPlanModePolicies(true);

    expect(policies).toContainEqual({ tool: "Bash", permission: "exclude" });
    expect(policies).toContainEqual({ tool: "Fetch", permission: "exclude" });
    expect(policies).toContainEqual({ tool: "*", permission: "exclude" });
    expect(policies).toContainEqual({ tool: "Read", permission: "allow" });
    expect(policies).toContainEqual({ tool: "List", permission: "allow" });
    expect(policies).toContainEqual({ tool: "Search", permission: "allow" });
  });
});
