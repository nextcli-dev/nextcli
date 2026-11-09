import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolInterruptedError } from "../tools/toolInterruptedError.js";
import type { PreprocessedToolCall } from "../tools/types.js";

import {
  capToolResult,
  executeStreamedToolCalls,
} from "./streamChatResponse.helpers.js";

vi.mock("../services/index.js", () => ({
  services: {
    chatHistory: {
      addToolResult: vi.fn(),
      updateToolStatus: vi.fn(),
    },
  },
  serviceContainer: {
    get: vi.fn().mockResolvedValue({ permissions: { policies: [] } }),
  },
  SERVICE_NAMES: { TOOL_PERMISSIONS: "toolPermissions" },
}));

vi.mock("../permissions/permissionChecker.js", () => ({
  checkToolPermission: vi.fn(() => ({ permission: "allow" })),
}));

vi.mock("../tools/index.js", () => ({
  executeToolCall: vi.fn(),
  getAllAvailableTools: vi.fn(),
  validateToolCallArgsPresent: vi.fn(),
}));

vi.mock("../telemetry/telemetryService.js", () => ({
  telemetryService: { logToolResult: vi.fn() },
}));

vi.mock("../util/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { services } = await import("../services/index.js");
const { checkToolPermission } = await import(
  "../permissions/permissionChecker.js"
);
const { executeToolCall } = await import("../tools/index.js");

function readCall(id: string): PreprocessedToolCall {
  return {
    id,
    name: "Read",
    arguments: { filepath: "/test.txt" },
    argumentsStr: '{"filepath":"/test.txt"}',
    startNotified: false,
    tool: { name: "Read" } as any,
  };
}

describe("executeStreamedToolCalls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkToolPermission).mockReturnValue({ permission: "allow" });
  });

  it("executes allowed tool calls and records the result", async () => {
    vi.mocked(executeToolCall).mockResolvedValue("file contents");
    const callbacks = { onToolStart: vi.fn(), onToolResult: vi.fn() };

    const { chatHistoryEntries, hasRejection } = await executeStreamedToolCalls(
      [readCall("call_1")],
      callbacks,
      true,
    );

    expect(hasRejection).toBe(false);
    expect(chatHistoryEntries).toEqual([
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "file contents",
        status: "done",
      },
    ]);
    expect(callbacks.onToolResult).toHaveBeenCalledWith(
      "file contents",
      "Read",
      "done",
    );
    expect(services.chatHistory.addToolResult).toHaveBeenCalledWith(
      "call_1",
      "file contents",
      "done",
    );
  });

  it("cancels excluded tool calls without running them", async () => {
    vi.mocked(checkToolPermission).mockReturnValue({ permission: "exclude" });

    const { chatHistoryEntries, hasRejection } = await executeStreamedToolCalls(
      [readCall("call_1")],
      undefined,
      true,
    );

    expect(hasRejection).toBe(true);
    expect(chatHistoryEntries[0]).toMatchObject({
      content: "Command blocked by security policy",
      status: "canceled",
    });
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  it("checks tool calls against the injected permissions source", async () => {
    const custom = { policies: [{ tool: "Read", permission: "exclude" }] };
    const getPermissions = vi.fn(async () => custom as any);
    // Excludes only when handed the injected permissions, not the session's
    vi.mocked(checkToolPermission).mockImplementation((_call, permissions) =>
      permissions === (custom as any)
        ? { permission: "exclude" }
        : { permission: "allow" },
    );

    const { chatHistoryEntries, hasRejection } = await executeStreamedToolCalls(
      [readCall("call_1")],
      undefined,
      true,
      undefined,
      getPermissions,
    );

    expect(getPermissions).toHaveBeenCalled();
    expect(hasRejection).toBe(true);
    expect(chatHistoryEntries[0]).toMatchObject({
      content: "Command blocked by security policy",
      status: "canceled",
    });
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  it("runs an allowed call under the injected permissions source", async () => {
    vi.mocked(executeToolCall).mockResolvedValue("file contents");
    const custom = { policies: [{ tool: "Read", permission: "allow" }] };
    vi.mocked(checkToolPermission).mockImplementation((_call, permissions) =>
      permissions === (custom as any)
        ? { permission: "allow" }
        : { permission: "exclude" },
    );

    const { hasRejection } = await executeStreamedToolCalls(
      [readCall("call_1")],
      undefined,
      true,
      undefined,
      async () => custom as any,
    );

    expect(hasRejection).toBe(false);
    expect(executeToolCall).toHaveBeenCalled();
  });

  it("records tool errors as errored results", async () => {
    vi.mocked(executeToolCall).mockRejectedValue(new Error("Execution failed"));

    const { chatHistoryEntries } = await executeStreamedToolCalls(
      [readCall("call_1")],
      undefined,
      true,
    );

    expect(chatHistoryEntries[0]).toMatchObject({
      content: "Error executing tool Read: Execution failed",
      status: "errored",
    });
  });

  // #12700
  it("caps oversized tool results before they reach the model", async () => {
    vi.mocked(executeToolCall).mockResolvedValue("x".repeat(500_000));

    const { chatHistoryEntries } = await executeStreamedToolCalls(
      [readCall("call_1")],
      undefined,
      true,
    );

    const content = String(chatHistoryEntries[0].content);
    expect(content.length).toBeLessThan(101_000);
    expect(content).toContain("characters of tool output truncated");
  });

  it("caps oversized error messages too", async () => {
    vi.mocked(executeToolCall).mockRejectedValue(
      new Error("stderr line\n".repeat(50_000)),
    );

    const { chatHistoryEntries } = await executeStreamedToolCalls(
      [readCall("call_1")],
      undefined,
      true,
    );

    expect(String(chatHistoryEntries[0].content)).toContain(
      "lines of tool output truncated",
    );
  });
});

// #12701: a tool call must never start once the turn is interrupted
describe("executeStreamedToolCalls after an interrupt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkToolPermission).mockReturnValue({ permission: "allow" });
  });

  it("cancels every call when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const { chatHistoryEntries, hasRejection } = await executeStreamedToolCalls(
      [readCall("call_1"), readCall("call_2")],
      undefined,
      true,
      controller.signal,
    );

    expect(executeToolCall).not.toHaveBeenCalled();
    expect(hasRejection).toBe(true);
    expect(chatHistoryEntries).toHaveLength(2);
    for (const entry of chatHistoryEntries) {
      expect(entry).toMatchObject({
        status: "canceled",
        content: expect.stringContaining("interrupted"),
      });
    }
  });

  it("does not run a call approved after the interrupt", async () => {
    const controller = new AbortController();
    vi.mocked(checkToolPermission).mockImplementation(() => {
      controller.abort();
      return { permission: "allow" };
    });

    const { chatHistoryEntries } = await executeStreamedToolCalls(
      [readCall("call_1")],
      undefined,
      true,
      controller.signal,
    );

    expect(executeToolCall).not.toHaveBeenCalled();
    expect(chatHistoryEntries[0]).toMatchObject({ status: "canceled" });
  });

  it("records a call interrupted before the tool ran as canceled", async () => {
    vi.mocked(executeToolCall).mockRejectedValue(new ToolInterruptedError());

    const { chatHistoryEntries, hasRejection } = await executeStreamedToolCalls(
      [readCall("call_1")],
      undefined,
      true,
      new AbortController().signal,
    );

    expect(hasRejection).toBe(true);
    expect(chatHistoryEntries[0]).toMatchObject({
      status: "canceled",
      content: expect.stringContaining("interrupted"),
    });
  });

  it("passes the signal to the tool", async () => {
    vi.mocked(executeToolCall).mockResolvedValue("ok");
    const controller = new AbortController();

    await executeStreamedToolCalls(
      [readCall("call_1")],
      undefined,
      true,
      controller.signal,
    );

    expect(executeToolCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("capToolResult", () => {
  it("leaves normal results unchanged", () => {
    expect(capToolResult("short result")).toBe("short result");
  });

  it("respects CONTINUE_CLI_TOOL_RESULT_MAX_CHARS", () => {
    process.env.CONTINUE_CLI_TOOL_RESULT_MAX_CHARS = "100";
    try {
      expect(capToolResult("y".repeat(1000)).length).toBeLessThan(200);
    } finally {
      delete process.env.CONTINUE_CLI_TOOL_RESULT_MAX_CHARS;
    }
  });
});
