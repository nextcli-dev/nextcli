import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkToolPermission } from "../permissions/permissionChecker.js";
import type { ToolPermissionServiceState } from "../services/ToolPermissionService.js";

import { executeSubAgent } from "./executor.js";

// The parent: a headless run with the closed defaults
const parentState = {
  currentMode: "normal",
  isHeadless: true,
  permissions: {
    policies: [
      { tool: "Fetch", permission: "exclude", source: "default" },
      { tool: "Bash", permission: "allow", source: "default" },
      { tool: "*", permission: "exclude", source: "default" },
    ],
  },
} as unknown as ToolPermissionServiceState;

let current: ToolPermissionServiceState = parentState;
let childState: ToolPermissionServiceState | undefined;

vi.mock("../services/ServiceContainer.js", () => ({
  serviceContainer: {
    get: vi.fn(async () => current),
    set: vi.fn((_name: string, state: ToolPermissionServiceState) => {
      current = state;
    }),
  },
}));

vi.mock("../services/index.js", () => ({ services: {} }));

vi.mock("../stream/streamChatResponse.js", () => ({
  // What the child session runs with is what is installed during its stream
  streamChatResponse: vi.fn(async () => {
    childState = current;
    return "";
  }),
}));

describe("executeSubAgent permissions", () => {
  beforeEach(() => {
    current = parentState;
    childState = undefined;
  });

  it("runs the child under the parent's closed policies and restores them after", async () => {
    const result = await executeSubAgent({
      agent: { model: { name: "child" }, llmApi: {} } as any,
      prompt: "look around",
      parentSessionId: "parent",
      abortController: new AbortController(),
    });

    expect(result.success).toBe(true);
    const permissions = childState!.permissions;
    const check = (name: string) =>
      checkToolPermission({ name, arguments: {} }, permissions).permission;
    expect(check("Fetch")).toBe("exclude");
    expect(check("Subagent")).toBe("exclude");
    expect(check("github_create_issue")).toBe("exclude");
    expect(check("Read")).toBe("exclude");
    // The parent's own state is back once the child finishes
    expect(current).toBe(parentState);
  });
});
