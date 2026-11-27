import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import { convertToUnifiedHistory } from "core/util/messageConversion.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestPrefix } from "../context/snapshot.js";
import { withTraceChain } from "../trace/trace.js";

import { streamChatResponse } from "./streamChatResponse.js";

// What each request's trace prefix was, from the real tracedPrefix
const prefixes = vi.hoisted(() => [] as (RequestPrefix | undefined)[]);

vi.mock("../context/snapshot.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../context/snapshot.js")>();
  return {
    ...actual,
    tracedContext: async () => undefined,
    tracedPrefix: async (...args: Parameters<typeof actual.tracedPrefix>) => {
      const prefix = await actual.tracedPrefix(...args);
      prefixes.push(prefix);
      return prefix;
    },
  };
});

vi.mock("../compaction.js", () => ({
  compactChatHistory: vi.fn(),
  shouldAutoCompact: vi.fn(),
  getAutoCompactMessage: vi.fn(() => "Auto-compacting..."),
}));

vi.mock("../session.js", () => ({
  getCurrentSession: () => ({ sessionId: "trace-chain-test" }),
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
    getRunId: () => "run",
  },
  warnBadEnv: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  services: {
    systemMessage: { getSystemMessage: vi.fn(async () => "System") },
    mcp: { getState: vi.fn(() => ({ tools: [] })) },
    toolPermissions: {
      getState: vi.fn(() => ({
        currentMode: "normal",
        permissions: { policies: [] },
      })),
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
  getRequestTools: vi.fn(async () => []),
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

const model = {
  name: "Test",
  provider: "openai",
  model: "test-model",
} as ModelConfig;

const llmApi = {
  chatCompletionStream: vi.fn(async function* () {
    yield {
      id: "test",
      object: "chat.completion.chunk" as const,
      created: 0,
      model: "test-model",
      choices: [{ index: 0, delta: { content: "Done." }, finish_reason: null }],
    };
  }),
} as unknown as BaseLlmApi;

const abort = () => ({ signal: { aborted: false }, abort: vi.fn() }) as any;

// Stands for the parent's agent loop while its tools or compaction run
const insideParent = withTraceChain(
  async (run: () => Promise<void>) => run(),
  () => false,
);

describe("streamChatResponse trace chains", () => {
  let traceDir: string;
  beforeEach(async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    traceDir = fs.mkdtempSync(`${os.tmpdir()}/trace-chain-`);
    process.env.NEXTCLI_TRACE = "basic";
    process.env.NEXTCLI_TRACE_DIR = traceDir;
    prefixes.length = 0;
  });
  afterEach(async () => {
    delete process.env.NEXTCLI_TRACE;
    delete process.env.NEXTCLI_TRACE_DIR;
    (await import("node:fs")).rmSync(traceDir, {
      recursive: true,
      force: true,
    });
  });

  it("keeps a compaction in the parent's chain and gives a nested loop its own", async () => {
    const turn = convertToUnifiedHistory([{ role: "user", content: "Fix it" }]);
    await streamChatResponse([...turn], model, llmApi, abort());
    const parentLast = turn.concat(
      convertToUnifiedHistory([{ role: "assistant", content: "Done." }]),
    );

    await insideParent(async () => {
      // A compaction: the parent's request plus the summary prompt
      await streamChatResponse(
        [
          ...parentLast,
          ...convertToUnifiedHistory([{ role: "user", content: "Summarize" }]),
        ],
        model,
        llmApi,
        abort(),
        undefined,
        true,
        undefined,
        { systemMessage: "System", tools: [] },
      );
      // A subagent: a loop of its own
      await streamChatResponse(
        convertToUnifiedHistory([{ role: "user", content: "Task" }]),
        model,
        llmApi,
        abort(),
      );
    });

    expect(prefixes).toHaveLength(3);
    expect(prefixes[0]?.extendsPrevious).toBeUndefined();
    expect(prefixes[1]).toMatchObject({ extendsPrevious: true });
    expect(prefixes[2]?.extendsPrevious).toBeUndefined();
  });
});
