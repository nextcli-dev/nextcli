import { beforeEach, describe, expect, it } from "vitest";

import { checkToolPermission } from "../permissions/permissionChecker.js";

import { serviceContainer } from "./ServiceContainer.js";
import type { ToolPermissionServiceState } from "./ToolPermissionService.js";

import { getServiceSync, initializeServices, SERVICE_NAMES } from "./index.js";

describe("Service Initialization", () => {
  beforeEach(() => {
    // Clean up service container state

    Object.keys(SERVICE_NAMES).forEach((service) => {
      // Reset service state
      (serviceContainer as any).services.delete(service);
      (serviceContainer as any).factories.delete(service);
      (serviceContainer as any).dependencies.delete(service);
    });
  });

  it("should have TOOL_PERMISSIONS service ready after initialization", async () => {
    // Before initialization, service should not be ready
    const beforeInit = getServiceSync(SERVICE_NAMES.TOOL_PERMISSIONS);
    expect(beforeInit.state).toBe("error"); // Not registered yet

    // Initialize services
    await initializeServices({
      headless: true,
      toolPermissionOverrides: {
        mode: "normal",
      },
    });

    // After initialization, service should be ready
    const afterInit = getServiceSync<ToolPermissionServiceState>(
      SERVICE_NAMES.TOOL_PERMISSIONS,
    );
    expect(afterInit.state).toBe("ready");
    expect(afterInit.value).toBeDefined();
    expect(afterInit.value?.currentMode).toBe("normal");
    expect(afterInit.value?.isHeadless).toBe(true);
  });

  it("keeps approvable defaults for a headless server whose client can approve calls", async () => {
    // cn serve: no terminal, but POST /permission answers each ask
    await initializeServices({ headless: true, approvalsAvailable: true });

    const state = getServiceSync<ToolPermissionServiceState>(
      SERVICE_NAMES.TOOL_PERMISSIONS,
    ).value!;
    expect(state.isHeadless).toBe(false);
    const write = checkToolPermission(
      { name: "Write", arguments: { filepath: "a.txt", content: "x" } },
      state.permissions,
    );
    expect(write.permission).toBe("ask");
  });

  it("closes the defaults for an unattended headless run", async () => {
    await initializeServices({ headless: true });

    const state = getServiceSync<ToolPermissionServiceState>(
      SERVICE_NAMES.TOOL_PERMISSIONS,
    ).value!;
    expect(state.isHeadless).toBe(true);
    const fetchCall = checkToolPermission(
      { name: "Fetch", arguments: { url: "https://example.com" } },
      state.permissions,
    );
    expect(fetchCall.permission).toBe("exclude");
  });

  it("should have TOOL_PERMISSIONS service ready immediately when accessed early", async () => {
    await initializeServices({
      headless: true,
    });

    // Simulate early access like in streamChatResponse
    const serviceResult = getServiceSync<ToolPermissionServiceState>(
      SERVICE_NAMES.TOOL_PERMISSIONS,
    );

    // Service should be ready, not idle
    expect(serviceResult.state).toBe("ready");
    expect(serviceResult.value).toBeDefined();
  });
});
