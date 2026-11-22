import { describe, expect, it, vi } from "vitest";

import { ChatMessage, ILLM } from "..";
import {
  abortCompaction,
  compactConversation,
  compactionKey,
  finishCompaction,
  startCompaction,
} from "./conversationCompaction";

/** A model whose chat answers with `content`, recording what it was sent */
function fakeModel(content: unknown) {
  const chat = vi.fn(async () => ({ role: "assistant", content }));
  return { model: { chat } as unknown as ILLM, chat };
}

// What the GUI builds with constructMessages: system prompt, context, turns
const messages: ChatMessage[] = [
  { role: "system", content: "You are a coding agent. Rule: tests first." },
  { role: "user", content: "Fix @src/auth.ts\n\n<file contents>" },
  { role: "assistant", content: "Fixed the token check." },
];

describe("compactConversation", () => {
  it("summarizes the messages the GUI built, with the cancel signal", async () => {
    const { model, chat } = fakeModel("The token check was fixed.");
    const signal = new AbortController().signal;

    const summary = await compactConversation({
      messages,
      currentModel: model,
      signal,
    });

    expect(summary).toBe("The token check was fixed.");
    const [sent, sentSignal] = chat.mock.calls[0] as unknown as [
      ChatMessage[],
      AbortSignal,
    ];
    // The system prompt and context reach the model, then the instruction
    expect(sent.slice(0, 3)).toEqual(messages);
    expect(sent[3]).toMatchObject({ role: "user" });
    expect(String(sent[3].content)).toContain("comprehensive summary");
    expect(sentSignal).toBe(signal);
  });

  it("keeps only the text of a summary with images", async () => {
    const { model } = fakeModel([
      { type: "text", text: "Summary" },
      { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AA" } },
    ]);

    await expect(
      compactConversation({
        messages,
        currentModel: model,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("Summary");
  });

  it("fails on an empty summary, so nothing replaces the conversation", async () => {
    const { model } = fakeModel("  ");

    await expect(
      compactConversation({
        messages,
        currentModel: model,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("empty summary");
  });

  it("lets a model error through", async () => {
    const model = {
      chat: vi.fn(async () => {
        throw new Error("401 invalid api key");
      }),
    } as unknown as ILLM;

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
    const key = compactionKey("session-1", 4);
    const controller = startCompaction(key);

    abortCompaction(compactionKey("session-1", 3));
    expect(controller.signal.aborted).toBe(false);

    abortCompaction(key);
    expect(controller.signal.aborted).toBe(true);
    finishCompaction(key, controller);
  });

  it("cancels an older compaction of the same message for a newer one", () => {
    const key = compactionKey("session-2", 1);
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
    const key = compactionKey("session-3", 0);
    const controller = startCompaction(key);
    finishCompaction(key, controller);

    abortCompaction(key);
    expect(controller.signal.aborted).toBe(false);
  });
});
