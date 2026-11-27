import type { ModelConfig } from "@nextcli/config-yaml";
import { describe, expect, it, vi } from "vitest";

vi.mock("../trace/trace.js", () => ({
  traceEnabled: () => true,
}));

import { tracedContext, tracedPrefix } from "./snapshot.js";

const model = {
  name: "Test",
  model: "test",
  provider: "openai",
  defaultCompletionOptions: { contextLength: 8_000, maxTokens: 1_000 },
} as ModelConfig;

describe("tracedContext", () => {
  it("builds a snapshot when traceEnabled is on, even if NEXTCLI_TRACE is unset", async () => {
    delete process.env.NEXTCLI_TRACE;
    const snapshot = await tracedContext({
      model,
      chatHistory: [],
      systemMessage: "You are a helper.",
    });
    expect(snapshot?.used).toBeGreaterThan(0);
  });
});

describe("tracedPrefix", () => {
  const tools = [
    {
      type: "function" as const,
      function: { name: "Read", parameters: { type: "object" } },
    },
  ];
  const system = { role: "system" as const, content: "parent" };
  const user = (content: string) => ({ role: "user" as const, content });

  it("compares a request with the last one on the same system message", async () => {
    const first = await tracedPrefix("parent", tools, [system, user("a")]);
    expect(first?.extendsPrevious).toBeUndefined();

    // A subagent's calls in between start their own chain
    const child = await tracedPrefix("child", [], [user("task")]);
    expect(child?.extendsPrevious).toBeUndefined();

    const next = await tracedPrefix("parent", tools, [
      system,
      user("a"),
      user("b"),
    ]);
    expect(next).toEqual({
      systemHash: first?.systemHash,
      toolsHash: first?.toolsHash,
      extendsPrevious: true,
    });
  });

  it("names what changed: the tools, or an earlier message", async () => {
    await tracedPrefix("rewrite", tools, [user("a"), user("b")]);

    const noTools = await tracedPrefix("rewrite", [], [user("a"), user("b")]);
    expect(noTools).toMatchObject({
      extendsPrevious: false,
      changed: "tools",
    });

    // A compaction replaces the history
    const compacted = await tracedPrefix("rewrite", [], [user("summary")]);
    expect(compacted).toMatchObject({
      extendsPrevious: false,
      changed: "messages",
    });
  });
});
