import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDefaultToolPolicies } from "../permissions/defaultPolicies.js";
import { checkToolPermission } from "../permissions/permissionChecker.js";
import type {
  ToolPermissions,
  ToolPermissionsSource,
} from "../permissions/types.js";

import { executeSubAgent } from "./executor.js";

const { containerSet } = vi.hoisted(() => ({ containerSet: vi.fn() }));
let childPermissions: ToolPermissions | undefined;

// The parent: a headless run with the closed defaults
const headlessParent: ToolPermissions = {
  policies: getDefaultToolPolicies(true),
  unattended: true,
};
let parent = headlessParent;

vi.mock("../services/ServiceContainer.js", () => ({
  serviceContainer: { get: vi.fn(), set: containerSet },
}));

vi.mock("../services/index.js", () => ({ services: {} }));

vi.mock("../stream/streamChatResponse.helpers.js", () => ({
  readSessionPermissions: async () => parent,
}));

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
    parent = headlessParent;
  });

  it("runs the child under the parent's permissions, without another subagent", async () => {
    const result = await executeSubAgent({
      agent: { model: { name: "child" }, llmApi: {} } as any,
      prompt: "look around",
      parentSessionId: "parent",
      abortController: new AbortController(),
    });

    expect(result.success).toBe(true);
    const check = (name: string, args: Record<string, unknown> = {}) =>
      checkToolPermission({ name, arguments: args }, childPermissions!)
        .permission;
    expect(check("Read")).toBe("allow");
    expect(check("Bash", { command: "ls" })).toBe("allow");
    expect(check("Bash", { command: "curl https://x" })).toBe("ask");
    expect(check("Fetch")).toBe("exclude");
    expect(check("github_create_issue")).toBe("exclude");
    expect(check("Subagent")).toBe("exclude");
    expect(childPermissions!.unattended).toBe(true);
    // A mode switch in the main session during the child's run is not undone
    expect(containerSet).not.toHaveBeenCalled();
  });

  it("keeps a subagent from asking the user, even when the main session may", async () => {
    // The terminal UI: the main session may ask
    parent = { policies: getDefaultToolPolicies(false) };
    expect(
      checkToolPermission({ name: "AskQuestion", arguments: {} }, parent)
        .permission,
    ).toBe("allow");

    await executeSubAgent({
      agent: { model: { name: "child" }, llmApi: {} } as any,
      prompt: "look around",
      parentSessionId: "parent",
      abortController: new AbortController(),
    });

    const check = (name: string) =>
      checkToolPermission({ name, arguments: {} }, childPermissions!)
        .permission;
    expect(check("AskQuestion")).toBe("exclude");
    expect(check("Read")).toBe("allow");
  });
});
