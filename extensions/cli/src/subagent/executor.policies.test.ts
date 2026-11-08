import { describe, expect, it } from "vitest";

import { checkToolPermission } from "../permissions/permissionChecker.js";

import { policiesForSubagentChild } from "./executor.js";

describe("policiesForSubagentChild", () => {
  it("keeps the parent's closed policies and cannot start another subagent", () => {
    const policies = policiesForSubagentChild([
      { tool: "Fetch", permission: "exclude", source: "default" },
      { tool: "Bash", permission: "allow", source: "default" },
      { tool: "*", permission: "exclude", source: "default" },
    ]);

    expect(
      checkToolPermission({ name: "Fetch", arguments: {} }, { policies })
        .permission,
    ).toBe("exclude");
    expect(
      checkToolPermission({ name: "Subagent", arguments: {} }, { policies })
        .permission,
    ).toBe("exclude");
    expect(
      checkToolPermission(
        { name: "github_create_issue", arguments: {} },
        { policies },
      ).permission,
    ).toBe("exclude");
    expect(
      policies.some(
        (policy) => policy.tool === "*" && policy.permission === "allow",
      ),
    ).toBe(false);
  });
});
