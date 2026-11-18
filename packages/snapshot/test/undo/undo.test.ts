import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { openSnapshotter } from "../../src/index.js";
import { createFixture } from "../helpers.js";

const read = (root: string, file: string) =>
  readFileSync(path.join(root, file), "utf8");

function storeGit(storeDir: string, root: string, ...args: string[]) {
  return execFileSync("git", args, {
    env: {
      PATH: process.env.PATH,
      GIT_DIR: storeDir,
      GIT_WORK_TREE: root,
      GIT_CONFIG_NOSYSTEM: "1",
    },
    encoding: "utf8",
  });
}

describe("undo and redo of a turn", () => {
  it("restores modified and deleted files and deletes created ones", async () => {
    const f = createFixture();
    const s = await f.open();
    const start = await s.capture("session/1/start");

    // The turn: an edit, a new nested file, and a deletion (as Bash would).
    f.write("a.txt", "a2\n");
    f.write("new/deep/c.txt", "c\n");
    rmSync(path.join(f.root, "b.txt"));
    const { end, files } = await s.finishTurn(start, "session/1/end");
    expect(files.sort()).toEqual(["a.txt", "b.txt", "new/deep/c.txt"]);

    const plan = await s.planRevert([{ start, end, files }]);
    expect(plan.restore).toEqual(["a.txt", "b.txt"]);
    expect(plan.delete).toEqual(["new/deep/c.txt"]);
    expect(plan.conflicts).toEqual([]);

    const result = await s.restore(plan.targets);
    expect(read(f.root, "a.txt")).toBe("a1\n");
    expect(read(f.root, "b.txt")).toBe("b1\n");
    expect(existsSync(path.join(f.root, "new"))).toBe(false);
    expect(result.deleted).toEqual(["new/deep/c.txt"]);

    // Redo puts the turn's work back.
    await s.restore(
      plan.targets.map((t) => ({ path: t.path, tree: result.redoTree })),
    );
    expect(read(f.root, "a.txt")).toBe("a2\n");
    expect(read(f.root, "new/deep/c.txt")).toBe("c\n");
    expect(existsSync(path.join(f.root, "b.txt"))).toBe(false);
  });

  it("undoes several turns back to the earliest start", async () => {
    const f = createFixture();
    const s = await f.open();
    const start1 = await s.capture();
    f.write("a.txt", "a2\n");
    const t1 = await s.finishTurn(start1);
    const start2 = await s.capture();
    f.write("a.txt", "a3\n");
    f.write("b.txt", "b2\n");
    const t2 = await s.finishTurn(start2);

    const plan = await s.planRevert([
      { start: start1, ...t1 },
      { start: start2, ...t2 },
    ]);
    await s.restore(plan.targets);
    expect(read(f.root, "a.txt")).toBe("a1\n");
    expect(read(f.root, "b.txt")).toBe("b1\n");
  });

  it("leaves files the turn didn't touch alone", async () => {
    const f = createFixture();
    const s = await f.open();
    const start = await s.capture();
    f.write("a.txt", "a2\n");
    const turn = await s.finishTurn(start);
    // The person edits another file after the turn.
    f.write("b.txt", "mine\n");

    const plan = await s.planRevert([{ start, ...turn }]);
    await s.restore(plan.targets);
    expect(read(f.root, "a.txt")).toBe("a1\n");
    expect(read(f.root, "b.txt")).toBe("mine\n");
  });

  it("reports files changed after the agent wrote them", async () => {
    const f = createFixture();
    const s = await f.open();
    const start = await s.capture();
    f.write("a.txt", "agent\n");
    f.write("b.txt", "agent\n");
    const turn = await s.finishTurn(start);
    f.write("a.txt", "person\n");

    const plan = await s.planRevert([{ start, ...turn }]);
    expect(plan.conflicts).toEqual(["a.txt"]);
  });

  it("works out the files of a turn that never finished", async () => {
    const f = createFixture();
    const s = await f.open();
    const start = await s.capture();
    f.write("a.txt", "a2\n");

    const plan = await s.planRevert([{ start }]);
    expect(plan.restore).toEqual(["a.txt"]);
    await s.restore(plan.targets);
    expect(read(f.root, "a.txt")).toBe("a1\n");
  });

  it("keeps ignored files that a .gitignore edit uncovered", async () => {
    const f = createFixture();
    f.write(".gitignore", ".env\n");
    f.git("add", ".gitignore");
    f.git("commit", "-qm", "ignore");
    f.write(".env", "SECRET=1\n");
    const s = await f.open();
    const start = await s.capture();

    // The turn stops ignoring .env, so the end snapshot contains it.
    f.write(".gitignore", "\n");
    const turn = await s.finishTurn(start);
    expect(turn.files.sort()).toEqual([".env", ".gitignore"]);

    const plan = await s.planRevert([{ start, ...turn }]);
    const result = await s.restore(plan.targets);
    expect(read(f.root, ".gitignore")).toBe(".env\n");
    expect(read(f.root, ".env")).toBe("SECRET=1\n");
    expect(result.keptIgnored).toEqual([".env"]);
    expect(result.deleted).toEqual([]);
  });

  it("keeps CRLF line endings and symlinks as they were", async () => {
    const f = createFixture();
    f.write("crlf.txt", "x\r\ny\r\n");
    if (process.platform !== "win32") {
      symlinkSync("a.txt", path.join(f.root, "link"));
    }
    const s = await f.open();
    const start = await s.capture();
    f.write("crlf.txt", "changed\n");
    if (process.platform !== "win32") {
      rmSync(path.join(f.root, "link"));
      writeFileSync(path.join(f.root, "link"), "not a link\n");
    }
    const turn = await s.finishTurn(start);
    await s.restore((await s.planRevert([{ start, ...turn }])).targets);

    expect(readFileSync(path.join(f.root, "crlf.txt"), "utf8")).toBe(
      "x\r\ny\r\n",
    );
    if (process.platform !== "win32") {
      expect(lstatSync(path.join(f.root, "link")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(path.join(f.root, "link"))).toBe("a.txt");
    }
  });
});

describe("failing safely", () => {
  it("changes no file when a snapshot object is missing", async () => {
    const f = createFixture();
    f.write("u.txt", "only in the snapshot store\n");
    const s = await f.open();
    const start = await s.capture();
    f.write("u.txt", "changed\n");
    f.write("a.txt", "a2\n");
    const turn = await s.finishTurn(start);

    const blob = execFileSync("git", ["hash-object", "--stdin"], {
      input: "only in the snapshot store\n",
      encoding: "utf8",
    }).trim();
    rmSync(path.join(s.storeDir, "objects", blob.slice(0, 2), blob.slice(2)));

    const plan = await s.planRevert([{ start, ...turn }]);
    await expect(s.restore(plan.targets)).rejects.toThrow(/missing/);
    expect(read(f.root, "u.txt")).toBe("changed\n");
    expect(read(f.root, "a.txt")).toBe("a2\n");
  });

  it("never deletes a file because git failed", async () => {
    const f = createFixture();
    const s = await f.open();
    await expect(
      s.restore([{ path: "a.txt", tree: "0".repeat(40) }]),
    ).rejects.toThrow();
    expect(read(f.root, "a.txt")).toBe("a1\n");
  });

  it("refuses paths outside the work tree", async () => {
    const f = createFixture();
    const s = await f.open();
    const tree = await s.capture();
    await expect(s.restore([{ path: "../outside.txt", tree }])).rejects.toThrow(
      /outside the work tree/,
    );
  });

  it("serialises opening and capturing from two processes sharing a store", async () => {
    const f = createFixture();
    const [s1, s2] = await Promise.all([f.open(), f.open()]);
    f.write("a.txt", "a2\n");
    const trees = await Promise.all([
      s1.capture(),
      s2.capture(),
      s1.capture(),
      s2.capture(),
    ]);
    expect(new Set(trees).size).toBe(1);
  });
});
