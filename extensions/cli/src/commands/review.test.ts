import { EventEmitter } from "events";

import { describe, expect, it, vi } from "vitest";

import { runReviewInWorker } from "./review.js";

const fork = vi.hoisted(() => vi.fn());

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fork,
}));
vi.mock("../util/logger.js", () => ({
  logger: { debug: vi.fn(), getLevel: () => "verbose" },
}));

describe("runReviewInWorker", () => {
  it("passes the log level to the worker, which never parses flags", async () => {
    fork.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        send: vi.fn(),
        kill: vi.fn(),
      });
      queueMicrotask(() =>
        child.emit("message", {
          type: "result",
          result: { patch: "", agentOutput: "", duration: 1 },
        }),
      );
      return child;
    });

    await runReviewInWorker(
      "agent",
      "/tmp/worktree",
      { changedFiles: [] } as any,
      {},
    );

    expect(fork.mock.calls[0][2].env).toMatchObject({
      NEXTCLI_LOG_LEVEL: "verbose",
    });
  });
});
