import { describe, expect, it, vi } from "vitest";

import { ChatMessage, ILLM } from "..";
import { BaseLLM } from "../llm";
import {
  abortCompaction,
  compactConversation,
  compactionKey,
  finishCompaction,
  startCompaction,
} from "./conversationCompaction";

/**
 * A model that compiles its requests as a real one does, dropping the oldest
 * messages that don't fit its window, and records what reaches it
 */
class SummaryModel extends BaseLLM {
  static providerName = "mock";
  received: ChatMessage[] | undefined;
  signal: AbortSignal | undefined;

  constructor(contextLength: number) {
    super({
      model: "mock",
      contextLength,
      completionOptions: { model: "mock", maxTokens: 1000 },
    });
    this.templateMessages = undefined;
  }

  protected async *_streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
  ): AsyncGenerator<ChatMessage> {
    this.received = messages;
    this.signal = signal;
    yield { role: "assistant", content: "The token check was fixed." };
  }
}

/** A log of `lines` distinct lines, about 7 tokens each */
const log = (name: string, lines: number) =>
  Array.from(
    { length: lines },
    (_, i) => `${name} line ${i}: request handled`,
  ).join("\n");

const toolTurn = (id: string, output: string): ChatMessage[] => [
  {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id,
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      },
    ],
  },
  { role: "tool", toolCallId: id, content: output },
];

// What the GUI builds with constructMessages: context, turns, tool results
const messages: ChatMessage[] = [
  { role: "user", content: "Fix @src/auth.ts\n\n<file contents>" },
  { role: "assistant", content: "Fixed the token check." },
];

describe("compactConversation", () => {
  it("summarizes the messages the GUI built, with the cancel signal", async () => {
    const model = new SummaryModel(32_000);
    const signal = new AbortController().signal;

    const result = await compactConversation({
      messages,
      currentModel: model,
      signal,
    });

    expect(result).toEqual({
      summary: "The token check was fixed.",
      shortenedOutputs: 0,
    });
    expect(model.received!.slice(0, 2)).toEqual(messages);
    expect(model.received![2]).toMatchObject({ role: "user" });
    expect(String(model.received![2].content)).toContain(
      "comprehensive summary",
    );
    expect(model.signal).toBe(signal);
  });

  it("shortens tool outputs to fit, so the summary covers the start too", async () => {
    const model = new SummaryModel(4_000);
    const transcript: ChatMessage[] = [
      { role: "user", content: "REQUIREMENT: keep the public API unchanged." },
      ...toolTurn("t1", log("server", 700)),
      ...toolTurn("t2", log("worker", 700)),
      { role: "assistant", content: "Found the cause in the worker." },
      { role: "user", content: "Now fix it" },
      { role: "assistant", content: "Fixed." },
    ];

    const result = await compactConversation({
      messages: transcript,
      currentModel: model,
      signal: new AbortController().signal,
    });

    expect(result.shortenedOutputs).toBe(2);
    // Every message reached the model: none was dropped to fit
    expect(model.received).toHaveLength(transcript.length + 1);
    expect(model.received![0].content).toBe(
      "REQUIREMENT: keep the public API unchanged.",
    );
    const outputs = model.received!.filter((m) => m.role === "tool");
    for (const output of outputs) {
      expect(output.content).toMatch(/characters of tool output truncated\)$/);
      expect(output.content.length).toBeGreaterThan(500);
    }
  });

  it("stops fitting when the compaction is cancelled", async () => {
    const model = new SummaryModel(4_000);
    const controller = new AbortController();
    controller.abort();

    await expect(
      compactConversation({
        messages: [
          { role: "user", content: "Check the logs" },
          ...toolTurn("t1", log("server", 700)),
        ],
        currentModel: model,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(model.received).toBeUndefined();
  });

  it("refuses a conversation that doesn't fit even with outputs shortened", async () => {
    const model = new SummaryModel(4_000);
    const transcript: ChatMessage[] = [
      { role: "user", content: log("pasted", 400) },
      { role: "assistant", content: "Read it." },
      { role: "user", content: log("pasted again", 400) },
      ...toolTurn("t1", log("server", 700)),
    ];

    await expect(
      compactConversation({
        messages: transcript,
        currentModel: model,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("too long to summarize in this model's window");
    expect(model.received).toBeUndefined();
  });

  it("keeps only the text of a summary with images", async () => {
    const model = {
      compileChatMessages: () => ({ didPrune: false }),
      chat: vi.fn(async () => ({
        role: "assistant",
        content: [
          { type: "text", text: "Summary" },
          { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AA" } },
        ],
      })),
    } as unknown as ILLM;

    await expect(
      compactConversation({
        messages,
        currentModel: model,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ summary: "Summary", shortenedOutputs: 0 });
  });

  it("fails on an empty summary, so nothing replaces the conversation", async () => {
    const model = new SummaryModel(32_000);
    vi.spyOn(model, "chat").mockResolvedValue({
      role: "assistant",
      content: "  ",
    });

    await expect(
      compactConversation({
        messages,
        currentModel: model,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("empty summary");
  });

  it("lets a model error through", async () => {
    const model = new SummaryModel(32_000);
    vi.spyOn(model, "chat").mockRejectedValue(new Error("401 invalid api key"));

    await expect(
      compactConversation({
        messages,
        currentModel: model,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("401 invalid api key");
  });
});

describe("compactions in progress", () => {
  it("can be cancelled by session and message", () => {
    const key = compactionKey("session-1", "message-4");
    const controller = startCompaction(key);

    abortCompaction(compactionKey("session-1", "message-3"));
    expect(controller.signal.aborted).toBe(false);

    abortCompaction(key);
    expect(controller.signal.aborted).toBe(true);
    finishCompaction(key, controller);
  });

  it("cancels an older compaction of the same message for a newer one", () => {
    const key = compactionKey("session-2", "message-1");
    const first = startCompaction(key);
    const second = startCompaction(key);

    expect(first.signal.aborted).toBe(true);
    // The older one finishing doesn't untrack the newer one
    finishCompaction(key, first);
    abortCompaction(key);
    expect(second.signal.aborted).toBe(true);
    finishCompaction(key, second);
  });

  it("is forgotten once finished", () => {
    const key = compactionKey("session-3", "message-0");
    const controller = startCompaction(key);
    finishCompaction(key, controller);

    abortCompaction(key);
    expect(controller.signal.aborted).toBe(false);
  });
});
