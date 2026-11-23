import type { ChatHistoryItem, PromptLog } from "core";
import { describe, expect, it } from "vitest";

import {
  formatTokens,
  formatUsd,
  responseNumber,
  sessionUsageByModel,
} from "./contextUsage";

const log = (overrides: Partial<PromptLog>): PromptLog => ({
  modelTitle: "Qwen 4.0",
  modelProvider: "qwen",
  prompt: "p",
  completion: "c",
  ...overrides,
});

const assistant = (promptLogs: PromptLog[], toolCallIds: string[] = []) =>
  ({
    message: { role: "assistant", content: "ok", id: Math.random().toString() },
    contextItems: [],
    promptLogs,
    toolCallStates: toolCallIds.map((toolCallId) => ({
      toolCallId,
      toolCall: {
        id: toolCallId,
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      },
      status: "done",
      parsedArgs: {},
    })),
  }) as unknown as ChatHistoryItem;

const user = () =>
  ({
    message: { role: "user", content: "go", id: Math.random().toString() },
    contextItems: [],
  }) as unknown as ChatHistoryItem;

describe("sessionUsageByModel", () => {
  it("sums each model's responses and leaves unpriced ones out of the cost", () => {
    const history = [
      user(),
      assistant([
        log({
          usage: {
            promptTokens: 1_000,
            completionTokens: 100,
            promptTokensDetails: { cachedTokens: 600, cacheWriteTokens: 50 },
            completionTokensDetails: { reasoningTokens: 40 },
          },
          costUsd: 0.25,
          priced: "catalog",
        }),
      ]),
      user(),
      assistant([
        log({
          usage: { promptTokens: 2_000, completionTokens: 300 },
        }),
        log({
          modelTitle: "Opus 5.5",
          modelProvider: "anthropic",
          usage: { promptTokens: 500, completionTokens: 50 },
          costUsd: 1.5,
          priced: "exact",
        }),
      ]),
      assistant([log({})]),
    ];

    const [qwen, opus] = sessionUsageByModel(history);

    expect(qwen).toMatchObject({
      modelTitle: "Qwen 4.0",
      requests: 3,
      withoutUsage: 1,
      input: 3_000,
      cached: 600,
      cacheWrite: 50,
      output: 400,
      reasoning: 40,
      costUsd: 0.25,
      pricedRequests: 1,
      priceSources: ["catalog"],
    });
    expect(opus).toMatchObject({
      modelTitle: "Opus 5.5",
      requests: 1,
      input: 500,
      costUsd: 1.5,
      pricedRequests: 1,
    });
  });

  it("keeps two providers' models with the same title apart", () => {
    const models = sessionUsageByModel([
      assistant([
        log({ modelProvider: "ollama" }),
        log({ modelProvider: "qwen" }),
      ]),
    ]);
    expect(models.map((m) => m.provider).sort()).toEqual(["ollama", "qwen"]);
  });

  it("is empty before the first response", () => {
    expect(sessionUsageByModel([user()])).toEqual([]);
  });
});

describe("responseNumber", () => {
  it("counts the session's responses up to the one that made the call", () => {
    const history = [
      user(),
      assistant([], ["call_a"]),
      user(),
      assistant([]),
      assistant([], ["call_b", "call_c"]),
    ];
    expect(responseNumber(history, "call_a")).toBe(1);
    expect(responseNumber(history, "call_c")).toBe(3);
    expect(responseNumber(history, "call_missing")).toBeUndefined();
  });
});

describe("formatting", () => {
  it("shortens token counts and keeps small costs visible", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_700)).toBe("1.7K");
    expect(formatTokens(1_050_000)).toBe("1.05M");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(2.314)).toBe("$2.31");
  });
});
