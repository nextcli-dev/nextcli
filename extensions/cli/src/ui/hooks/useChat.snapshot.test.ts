import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { ChatHistoryItem } from "core/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { services } from "../../services/index.js";

import {
  applyRedo,
  applyUndo,
  beginTurnSnapshot,
  findUndoTarget,
  finishTurnSnapshot,
} from "./useChat.snapshot.js";

vi.mock("../../util/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const user = (content: string): ChatHistoryItem => ({
  message: { role: "user", content },
  contextItems: [],
});
const assistant = (content: string): ChatHistoryItem => ({
  message: { role: "assistant", content },
  contextItems: [],
});

let root: string;

beforeEach(async () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "cn-undo-ui-")));
  root = path.join(base, "repo");
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(path.join(root, "a.txt"), "a1\n");
  await services.snapshot.initialize({
    enabled: true,
    cwd: root,
    storeRoot: path.join(base, "store"),
  });
  // Remote mode keeps the history in memory, without session files.
  await services.chatHistory.initialize(undefined, true);
});

/** Runs one turn the way useChat does: snapshot, tool writes, snapshot. */
async function runTurn(prompt: string, write: () => void) {
  services.chatHistory.setHistory([
    ...services.chatHistory.getHistory(),
    user(prompt),
  ]);
  const turn = await beginTurnSnapshot();
  expect(turn).toBeDefined();
  write();
  services.chatHistory.setHistory([
    ...services.chatHistory.getHistory(),
    assistant(`did ${prompt}`),
  ]);
  await finishTurnSnapshot(turn!);
}

describe("turn snapshots in the chat", () => {
  it("stores the start, end and changed files on the user message", async () => {
    await runTurn("edit a", () =>
      writeFileSync(path.join(root, "a.txt"), "a2\n"),
    );
    const [item] = services.chatHistory.getHistory();
    expect(item.checkpoint?.roots).toEqual([
      expect.objectContaining({
        root,
        start: expect.any(String),
        end: expect.any(String),
        files: ["a.txt"],
      }),
    ]);
  });

  it("undoes the last turn with its conversation, and redoes it", async () => {
    await runTurn("first", () =>
      writeFileSync(path.join(root, "a.txt"), "a2\n"),
    );
    await runTurn("second", () =>
      writeFileSync(path.join(root, "b.txt"), "b\n"),
    );
    const history = services.chatHistory.getHistory();

    const target = findUndoTarget(history);
    expect(target).toEqual({ fromIndex: 2 });
    const plan = await services.snapshot.planUndo(history, 2);
    const undone = await applyUndo(history, plan, "code-and-conversation");
    expect(undone.history).toEqual(history.slice(0, 2));
    expect(undone.message).toMatch(/deleted 1 file/);
    expect(existsSync(path.join(root, "b.txt"))).toBe(false);
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a2\n");

    const redone = await applyRedo(undone.history!);
    expect(redone.history).toEqual(history);
    expect(readFileSync(path.join(root, "b.txt"), "utf8")).toBe("b\n");
  });

  it("restores code only and keeps the conversation", async () => {
    await runTurn("edit a", () =>
      writeFileSync(path.join(root, "a.txt"), "a2\n"),
    );
    const history = services.chatHistory.getHistory();
    const plan = await services.snapshot.planUndo(history, 0);
    const undone = await applyUndo(history, plan, "code");
    expect(undone.history).toBeUndefined();
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a1\n");
  });

  it("explains why there is nothing to undo", async () => {
    expect(findUndoTarget([user("x")])).toEqual({
      message: expect.stringMatching(/Nothing to undo/),
    });
    await services.snapshot.initialize({ enabled: false });
    expect(findUndoTarget([user("x")])).toEqual({
      message: expect.stringMatching(/Undo is off: snapshots are turned off/),
    });
    expect(await applyRedo([])).toEqual({
      message: expect.stringMatching(/Redo is off/),
    });
  });
});
