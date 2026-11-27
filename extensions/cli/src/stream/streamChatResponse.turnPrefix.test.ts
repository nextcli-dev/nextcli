import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import { convertToUnifiedHistory } from "core/util/messageConversion.js";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.mjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { services } from "../services/index.js";

import { getRequestTools } from "./handleToolCalls.js";
import { streamChatResponse } from "./streamChatResponse.js";

vi.mock("../compaction.js", () => ({
  compactChatHistory: vi.fn(),
  shouldAutoCompact: vi.fn(),
  getAutoCompactMessage: vi.fn(() => "Auto-compacting..."),
}));

vi.mock("../session.js", () => ({
  updateSessionHistory: vi.fn(),
  trackSessionUsage: vi.fn(),
  getSessionUsage: vi.fn(() => ({
    promptTokens: 0,
    completionTokens: 0,
    totalCost: 0,
  })),
}));

vi.mock("../util/tokenizer.js", () => ({
  historySentToModel: (history: { message: { role: string } }[]) =>
    history.filter((item) => item.message.role !== "system"),
  countChatHistoryItemTokens: vi.fn(() => 100),
  countTotalInputTokens: vi.fn(() => 1000),
  getModelMaxTokens: vi.fn(() => 100_000),
  validateContextLength: vi.fn(() => ({ isValid: true })),
  estimateOutputTokens: vi.fn(() => 0),
}));

vi.mock("../telemetry/telemetryService.js", () => ({
  telemetryService: {
    logApiRequest: vi.fn(),
    recordResponseTime: vi.fn(),
    recordTokenUsage: vi.fn(),
    recordCost: vi.fn(),
  },
}));

vi.mock("../util/logger.js", () => ({
  logger: {
    trace: vi.fn(),
    verbose: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

const permissionState = vi.hoisted(() => ({
  currentMode: "normal",
  permissions: { policies: [] as unknown[] },
}));
const mcpState = vi.hoisted(() => ({ tools: [] as unknown[] }));

vi.mock("../services/index.js", () => ({
  services: {
    systemMessage: { getSystemMessage: vi.fn() },
    mcp: { getState: vi.fn(() => ({ ...mcpState })) },
    toolPermissions: {
      getState: vi.fn(() => ({ ...permissionState })),
      isHeadless: vi.fn(() => true),
    },
    chatHistory: {
      isReady: vi.fn(() => true),
      getHistory: vi.fn(() => []),
      setHistory: vi.fn(),
      addUserMessage: vi.fn(),
    },
  },
}));

vi.mock("./handleToolCalls.js", () => ({
  handleToolCalls: vi.fn(() => Promise.resolve(false)),
  getRequestTools: vi.fn(),
}));

vi.mock("./streamChatResponse.compactionHelpers.js", () => ({
  handlePreApiCompaction: vi.fn((chatHistory) =>
    Promise.resolve({ chatHistory, wasCompacted: false }),
  ),
  handlePostToolValidation: vi.fn((_, chatHistory) =>
    Promise.resolve({ chatHistory, wasCompacted: false }),
  ),
  handleNormalAutoCompaction: vi.fn((chatHistory) =>
    Promise.resolve({ chatHistory, wasCompacted: false }),
  ),
}));

function chunk(delta: ChatCompletionChunk["choices"][0]["delta"]) {
  return {
    id: "test",
    object: "chat.completion.chunk" as const,
    created: 0,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}

const readCall = () =>
  chunk({
    tool_calls: [
      {
        index: 0,
        id: `call_${Math.random()}`,
        type: "function",
        function: { name: "Read", arguments: '{"filepath":"a.ts"}' },
      },
    ],
  });

describe("streamChatResponse - the request prefix of a turn", () => {
  const model = {
    provider: "openai",
    name: "gpt-4",
    model: "gpt-4",
    defaultCompletionOptions: { contextLength: 100_000, maxTokens: 2048 },
  } as unknown as ModelConfig;
  let requests: { system: unknown; tools: unknown }[];
  let builds: number;
  let onRequest: (call: number) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(permissionState, {
      currentMode: "normal",
      permissions: { policies: [] },
    });
    mcpState.tools = [];
    requests = [];
    builds = 0;
    onRequest = () => {};
    // Each build differs, as when the agent edits AGENTS.md or adds a skill
    vi.mocked(services.systemMessage.getSystemMessage).mockImplementation(
      async () => `System v${++builds}`,
    );
    vi.mocked(getRequestTools).mockImplementation(async () => [
      {
        type: "function",
        function: { name: "Read", description: `Read v${builds}` },
      },
    ]);
  });

  // Three tool rounds, then an answer
  const llmApi = {
    chatCompletionStream: vi.fn(async function* (body: {
      messages: { content: unknown }[];
      tools?: unknown;
    }) {
      requests.push({ system: body.messages[0].content, tools: body.tools });
      onRequest(requests.length);
      yield requests.length < 4 ? readCall() : chunk({ content: "Done" });
    }),
  } as unknown as BaseLlmApi;

  const turn = (text: string) =>
    streamChatResponse(
      convertToUnifiedHistory([{ role: "user", content: text }]),
      model,
      llmApi,
      {
        signal: { aborted: false },
        abort: vi.fn(),
      } as unknown as AbortController,
    );

  it("sends the same system message and tools on every request of a turn", async () => {
    await turn("Fix the bug");

    expect(requests).toHaveLength(4);
    expect(new Set(requests.map((r) => r.system))).toEqual(
      new Set(["System v1"]),
    );
    expect(new Set(requests.map((r) => JSON.stringify(r.tools))).size).toBe(1);
    expect(services.systemMessage.getSystemMessage).toHaveBeenCalledTimes(1);
  });

  it("builds them again at the next user message", async () => {
    await turn("Fix the bug");
    requests = [];
    await turn("Now add a test");

    expect(requests[0].system).toBe("System v2");
    expect(JSON.stringify(requests[0].tools)).toContain("Read v2");
  });

  it("builds them again when the mode switches mid-turn", async () => {
    // Shift+Tab to plan mode while the second request streams
    onRequest = (call) => {
      if (call === 2) {
        permissionState.currentMode = "plan";
      }
    };
    await turn("Fix the bug");

    expect(requests.map((r) => r.system)).toEqual([
      "System v1",
      "System v1",
      "System v2",
      "System v2",
    ]);
    expect(services.systemMessage.getSystemMessage).toHaveBeenLastCalledWith(
      "plan",
    );
  });

  it("builds them again when the permission policies change mid-turn", async () => {
    onRequest = (call) => {
      if (call === 2) {
        permissionState.permissions = { policies: [{ tool: "Bash" }] };
      }
    };
    await turn("Fix the bug");

    expect(requests.map((r) => r.system)).toEqual([
      "System v1",
      "System v1",
      "System v2",
      "System v2",
    ]);
  });

  // A slow MCP server finishes connecting after the turn's first request.
  // Permissions don't change, but the tools offered do.
  it("builds them again when an MCP server connects mid-turn", async () => {
    onRequest = (call) => {
      if (call === 2) {
        mcpState.tools = [{ name: "github_search" }];
      }
    };
    await turn("Fix the bug");

    expect(requests.map((r) => r.system)).toEqual([
      "System v1",
      "System v1",
      "System v2",
      "System v2",
    ]);
    expect(JSON.stringify(requests[2].tools)).toContain("Read v2");
  });

  it("sends a compaction the turn's prefix as it is, without reading the files again", async () => {
    const turnTools = [
      { type: "function" as const, function: { name: "Read" } },
    ];
    const summary = streamChatResponse(
      convertToUnifiedHistory([{ role: "user", content: "Summarize" }]),
      model,
      llmApi,
      {
        signal: { aborted: false },
        abort: vi.fn(),
      } as unknown as AbortController,
      undefined,
      true,
      undefined,
      { systemMessage: "The turn's system message", tools: turnTools },
    );

    // The fake model calls a tool even without tools: no summary to keep
    await expect(summary).rejects.toThrow(/tool call/);
    expect(requests[0]).toEqual({
      system: "The turn's system message",
      tools: turnTools,
    });
    expect(services.systemMessage.getSystemMessage).not.toHaveBeenCalled();
    expect(getRequestTools).not.toHaveBeenCalled();
    // It answered with a tool call only: asked once more, without tools
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({
      system: "The turn's system message",
      tools: undefined,
    });
  });
});
