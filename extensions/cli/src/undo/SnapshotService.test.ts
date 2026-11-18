import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { ChatHistoryItem } from "core/index.js";
import { describe, expect, it, vi } from "vitest";

import { shouldSnapshot, SnapshotService } from "./SnapshotService.js";

vi.mock("../util/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createRepo() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "cn-undo-")));
  const root = path.join(base, "repo");
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(path.join(root, "a.txt"), "a1\n");
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@e",
      "commit",
      "-qm",
      "i",
      "--allow-empty",
    ],
    { cwd: root },
  );
  return { root, storeRoot: path.join(base, "store") };
}

const user = (content: string): ChatHistoryItem => ({
  message: { role: "user", content },
  contextItems: [],
});
const assistant = (content: string): ChatHistoryItem => ({
  message: { role: "assistant", content },
  contextItems: [],
});

describe("shouldSnapshot", () => {
  it("is on in the terminal UI", () => {
    expect(shouldSnapshot({}, {})).toBe(true);
    expect(
      shouldSnapshot({ snapshots: true }, { NEXTCLI_SNAPSHOTS: "1" }),
    ).toBe(true);
  });

  it("is off for headless runs, which include cn serve and cn review", () => {
    expect(shouldSnapshot({ headless: true }, {})).toBe(false);
  });

  it("is off with --no-snapshots or NEXTCLI_SNAPSHOTS=0", () => {
    expect(shouldSnapshot({ snapshots: false }, {})).toBe(false);
    expect(shouldSnapshot({}, { NEXTCLI_SNAPSHOTS: "0" })).toBe(false);
    expect(shouldSnapshot({}, { NEXTCLI_SNAPSHOTS: "off" })).toBe(false);
  });
});

describe("SnapshotService", () => {
  it("stays off when disabled or outside a git repository", async () => {
    const off = new SnapshotService();
    await off.initialize({ enabled: false });
    await off.settled();
    expect(off.isEnabled()).toBe(false);
    expect(off.getState().reason).toBe("off");
    expect(await off.beginTurn("s")).toBeUndefined();

    const dir = mkdtempSync(path.join(tmpdir(), "cn-undo-nogit-"));
    const noGit = new SnapshotService();
    vi.stubEnv("GIT_CEILING_DIRECTORIES", tmpdir());
    await noGit.initialize({ enabled: true, cwd: dir, storeRoot: dir });
    await noGit.settled();
    vi.unstubAllEnvs();
    expect(noGit.getState()).toMatchObject({
      enabled: false,
      reason: "not-a-git-repo",
    });
  });

  it("undoes and redoes a turn's file changes", async () => {
    const { root, storeRoot } = createRepo();
    const service = new SnapshotService();
    await service.initialize({ enabled: true, cwd: root, storeRoot });
    await service.settled();

    const begun = await service.beginTurn("session-1");
    expect(begun).toBeDefined();
    writeFileSync(path.join(root, "a.txt"), "a2\n");
    writeFileSync(path.join(root, "new.txt"), "new\n");
    const checkpoint = await service.finishTurn(begun!.turn);
    expect(checkpoint?.roots[0].files?.sort()).toEqual(["a.txt", "new.txt"]);

    const history = [
      { ...user("change things"), checkpoint },
      assistant("done"),
    ];
    expect(service.lastUndoableIndex(history)).toBe(0);
    const plan = await service.planUndo(history, 0);
    expect(plan.plan.restore).toEqual(["a.txt"]);
    expect(plan.plan.delete).toEqual(["new.txt"]);

    await service.undo(plan, history);
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a1\n");
    expect(existsSync(path.join(root, "new.txt"))).toBe(false);
    expect(service.getState().canRedo).toBe(true);

    const redone = await service.redo();
    expect(redone?.removedHistory).toEqual(history);
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a2\n");
    expect(readFileSync(path.join(root, "new.txt"), "utf8")).toBe("new\n");
    expect(service.getState().canRedo).toBe(false);
    expect(await service.redo()).toBeUndefined();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps redo when an undo fails after changing files",
    async () => {
      const { root, storeRoot } = createRepo();
      const service = new SnapshotService();
      await service.initialize({ enabled: true, cwd: root, storeRoot });
      await service.settled();

      const begun = await service.beginTurn("s");
      writeFileSync(path.join(root, "a.txt"), "a2\n");
      mkdirSync(path.join(root, "locked"));
      writeFileSync(path.join(root, "locked", "new.txt"), "new\n");
      const checkpoint = await service.finishTurn(begun!.turn);
      const history = [{ ...user("x"), checkpoint }];
      const plan = await service.planUndo(history, 0);

      // a.txt is restored, then deleting locked/new.txt fails.
      chmodSync(path.join(root, "locked"), 0o555);
      try {
        await expect(service.undo(plan)).rejects.toThrow(/partway/);
      } finally {
        chmodSync(path.join(root, "locked"), 0o755);
      }
      expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a1\n");
      expect(service.getState().canRedo).toBe(true);

      await service.redo();
      expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a2\n");
    },
  );

  it("makes an undo final once the next turn starts", async () => {
    const { root, storeRoot } = createRepo();
    const service = new SnapshotService();
    await service.initialize({ enabled: true, cwd: root, storeRoot });
    await service.settled();

    const begun = await service.beginTurn("s");
    writeFileSync(path.join(root, "a.txt"), "a2\n");
    const checkpoint = await service.finishTurn(begun!.turn);
    const history = [{ ...user("x"), checkpoint }];
    await service.undo(await service.planUndo(history, 0));
    expect(service.getState().canRedo).toBe(true);

    await service.beginTurn("s");
    expect(service.getState().canRedo).toBe(false);
  });

  it("keeps the first start when an interrupted turn resumes", async () => {
    const { root, storeRoot } = createRepo();
    const service = new SnapshotService();
    await service.initialize({ enabled: true, cwd: root, storeRoot });
    await service.settled();

    const first = await service.beginTurn("s");
    writeFileSync(path.join(root, "a.txt"), "a2\n");
    const resumed = await service.beginTurn("s", first!.checkpoint);
    expect(resumed?.turn.start).toBe(first!.turn.start);
  });

  it("refuses to plan an undo for a message without a snapshot", async () => {
    const { root, storeRoot } = createRepo();
    const service = new SnapshotService();
    await service.initialize({ enabled: true, cwd: root, storeRoot });
    await service.settled();
    const history = [user("no snapshot"), assistant("ok")];
    expect(service.lastUndoableIndex(history)).toBeUndefined();
    expect(service.canRestore(history, 0)).toBe(false);
    await expect(service.planUndo(history, 0)).rejects.toThrow(/no snapshot/);
  });
});
