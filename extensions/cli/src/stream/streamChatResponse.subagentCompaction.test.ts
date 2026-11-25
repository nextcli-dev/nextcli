import fs from "fs";
import path from "path";

import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import { describe, expect, it, vi } from "vitest";

import { ChatHistoryService } from "../services/ChatHistoryService.js";
import { getCurrentSession, updateSessionHistory } from "../session.js";

import { handlePreApiCompaction } from "./streamChatResponse.compactionHelpers.js";

const item = (
  role: "user" | "assistant",
  content: string,
): ChatHistoryItem => ({
  message: { role, content },
  contextItems: [],
});

vi.mock("../compaction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../compaction.js")>()),
  shouldAutoCompact: vi.fn(() => true),
  compactChatHistory: vi.fn(async () => ({
    compactedHistory: [
      {
        ...item("assistant", "a summary"),
        conversationSummary: "a summary",
      },
    ],
    compactionIndex: 0,
    compactionContent: "a summary",
    omittedMessages: 0,
    shortenedOutputs: 0,
  })),
}));

// While a subagent runs, the executor marks the main session's history
// service not ready (subagent/executor.ts)
const historyService = vi.hoisted(() => ({
  current: undefined as ChatHistoryService | undefined,
}));

vi.mock("../services/index.js", () => ({
  services: {
    get chatHistory() {
      return historyService.current ?? { isReady: () => false };
    },
  },
}));

const options = {
  model: { name: "m", model: "m", provider: "openai" } as ModelConfig,
  llmApi: {} as BaseLlmApi,
  isCompacting: false,
  isHeadless: false,
  systemMessage: "System message",
};

const sessionFile = (sessionId: string) =>
  path.join(process.env.CONTINUE_GLOBAL_DIR!, "sessions", `${sessionId}.json`);

describe("auto-compaction during a turn", () => {
  it("in a subagent leaves the main session's file as it was", async () => {
    // vitest.global-dir-setup.ts gives each test file its own
    // CONTINUE_GLOBAL_DIR, which cn and core's HistoryManager share
    const parent = getCurrentSession().sessionId;
    updateSessionHistory([
      item("user", "the main task"),
      item("assistant", "delegating"),
    ]);
    const file = sessionFile(parent);
    const before = fs.readFileSync(file, "utf8");

    const result = await handlePreApiCompaction(
      [item("user", "the subagent's task"), item("assistant", "a long read")],
      options,
    );

    // The subagent goes on from its own summary
    expect(result.wasCompacted).toBe(true);
    expect(result.chatHistory[0].conversationSummary).toBe("a summary");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(getCurrentSession().history[0].message.content).toBe(
      "the main task",
    );
  });

  it("in the main session writes the summary to its file", async () => {
    const service = new ChatHistoryService();
    await service.initialize();
    historyService.current = service;
    try {
      const history = [
        item("user", "the main task"),
        item("assistant", "a read"),
      ];
      service.setHistory(history);

      await handlePreApiCompaction(service.getHistory(), options);

      const saved = JSON.parse(
        fs.readFileSync(sessionFile(getCurrentSession().sessionId), "utf8"),
      );
      expect(saved.history[0].conversationSummary).toBe("a summary");
    } finally {
      historyService.current = undefined;
    }
  });
});
