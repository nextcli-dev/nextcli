import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdeMessenger } from "./IdeMessenger";

let posted: { messageId: string; messageType: string }[] = [];

/** The extension host answers the stream request with this message */
function fromHost(messageId: string, data: unknown) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { messageId, messageType: "llm/streamChat", data },
    }),
  );
}

function startStream() {
  const gen = new IdeMessenger().streamRequest(
    "llm/streamChat",
    {} as any,
    new AbortController().signal,
  );
  // The request is posted when the generator first runs
  const first = gen.next();
  const messageId = posted[posted.length - 1].messageId;
  return { gen, first, messageId };
}

describe("IdeMessenger.streamRequest", () => {
  beforeEach(() => {
    posted = [];
    vi.useFakeTimers();
    vi.stubGlobal("vscode", {
      postMessage: (msg: { messageId: string; messageType: string }) => {
        posted.push(msg);
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("yields a chunk as soon as it arrives, not on a polling interval", async () => {
    const { first, messageId } = startStream();
    await vi.advanceTimersByTimeAsync(200);

    fromHost(messageId, { done: false, content: "Hel" });
    // Only the zero-delay batching tick, far below the old 50 ms poll
    await vi.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toEqual({ done: false, value: ["Hel"] });
  });

  it("delivers chunks that arrive together as one batch", async () => {
    const { first, messageId } = startStream();
    fromHost(messageId, { done: false, content: "a" });
    fromHost(messageId, { done: false, content: "b" });
    await vi.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toEqual({ done: false, value: ["a", "b"] });
  });

  it("yields what is left, then returns the final value when done", async () => {
    const { gen, first, messageId } = startStream();
    fromHost(messageId, { done: false, content: "a" });
    await vi.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toEqual({ done: false, value: ["a"] });

    const next = gen.next();
    fromHost(messageId, { done: false, content: "b" });
    fromHost(messageId, { done: true, content: "log" });
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toEqual({ done: false, value: ["b"] });
    await expect(gen.next()).resolves.toEqual({ done: true, value: "log" });
  });

  it("throws an error from the host without waiting for more messages", async () => {
    const { first, messageId } = startStream();
    const settled = first.catch((e: Error) => e);
    fromHost(messageId, { error: "model failed" });
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toEqual(new Error("model failed"));
  });

  it("ignores messages for other streams", async () => {
    const { first, messageId } = startStream();
    let settled = false;
    void first.then(() => (settled = true));
    fromHost("someone-else", { done: false, content: "x" });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);

    fromHost(messageId, { done: false, content: "mine" });
    await vi.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toEqual({ done: false, value: ["mine"] });
  });
});
