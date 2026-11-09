import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkToolPermission } from "../permissions/permissionChecker.js";
import type {
  ToolPermissions,
  ToolPermissionsSource,
} from "../permissions/types.js";

import { executeSubAgent } from "./executor.js";

const { containerSet } = vi.hoisted(() => ({ containerSet: vi.fn() }));
let childPermissions: ToolPermissions | undefined;

vi.mock("../services/ServiceContainer.js", () => ({
  serviceContainer: { get: vi.fn(), set: containerSet },
}));

vi.mock("../services/index.js", () => ({ services: {} }));

vi.mock("../stream/streamChatResponse.js", () => ({
  // The child runs with the permissions passed to its stream
  streamChatResponse: vi.fn(async (...args: unknown[]): Promise<string> => {
    const getPermissions = args[6] as ToolPermissionsSource | undefined;
    childPermissions = await getPermissions?.();
    return "";
  }),
}));

describe("executeSubAgent permissions", () => {
  beforeEach(() => {
    containerSet.mockClear();
    childPermissions = undefined;
  });

  it("passes the child its permissions without replacing the main session's", async () => {
    const result = await executeSubAgent({
      agent: { model: { name: "child" }, llmApi: {} } as any,
      prompt: "look around",
      parentSessionId: "parent",
      abortController: new AbortController(),
    });

    expect(result.success).toBe(true);
    const check = (name: string) =>
      checkToolPermission({ name, arguments: {} }, childPermissions!)
        .permission;
    // main: the child allows every tool
    expect(check("Read")).toBe("allow");
    expect(check("github_create_issue")).toBe("allow");
    // A mode switch in the main session during the child's run is not undone
    expect(containerSet).not.toHaveBeenCalled();
  });
});
