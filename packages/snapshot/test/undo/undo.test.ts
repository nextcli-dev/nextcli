import { execFileSync } from "node:child_process";
import {
  chmodSync,
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

import { openSnapshotter, RestoreError } from "../../src/index.js";
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
    expect(plan.conflicts).toEqual(["a.txt"]);
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

describe("symlinks and directories", () => {
  it.skipIf(process.platform === "win32")(
    "undoes a symlink that became a directory, and redoes it",
    async () => {
      const f = createFixture();
      f.write("target/kept.txt", "kept\n");
      symlinkSync("target", path.join(f.root, "link"));
      const s = await f.open();
      const start = await s.capture();
      rmSync(path.join(f.root, "link"));
      f.write("link/secret.txt", "secret\n");
      const turn = await s.finishTurn(start);
      expect(turn.files.sort()).toEqual(["link", "link/secret.txt"]);

      const plan = await s.planRevert([{ start, ...turn }]);
      const undone = await s.restore(plan.targets);
      expect(lstatSync(path.join(f.root, "link")).isSymbolicLink()).toBe(true);
      expect(undone.restored).toEqual(["link"]);
      // The checkout already removed the directory; nothing else was deleted.
      expect(undone.deleted).toEqual([]);
      expect(read(f.root, "target/kept.txt")).toBe("kept\n");

      const redone = await s.restore(
        plan.targets.map((t) => ({ ...t, tree: undone.redoTree })),
      );
      expect(lstatSync(path.join(f.root, "link")).isDirectory()).toBe(true);
      expect(read(f.root, "link/secret.txt")).toBe("secret\n");
      expect(redone.restored).toEqual(["link/secret.txt"]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "never deletes through a symlinked folder",
    async () => {
      const f = createFixture();
      const outside = mkdtempSync(path.join(tmpdir(), "cn-outside-"));
      writeFileSync(path.join(outside, "victim.txt"), "keep me\n");
      symlinkSync(outside, path.join(f.root, "out"));
      const s = await f.open();
      const tree = await s.capture();
      const result = await s.restore([{ path: "out/victim.txt", tree }]);
      expect(result.deleted).toEqual([]);
      expect(readFileSync(path.join(outside, "victim.txt"), "utf8")).toBe(
        "keep me\n",
      );
    },
  );

  it("reports only deletions that happened", async () => {
    const f = createFixture();
    const s = await f.open();
    const start = await s.capture();
    f.write("new.txt", "x\n");
    f.write("dir/inner.txt", "y\n");
    const turn = await s.finishTurn(start);
    // The person removed one of them already.
    rmSync(path.join(f.root, "new.txt"));
    const result = await s.restore(
      [...turn.files, "dir"].map((file) => ({ path: file, tree: start })),
    );
    expect(result.deleted).toEqual(["dir/inner.txt"]);
    expect(existsSync(path.join(f.root, "dir"))).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps the redo tree when a restore fails partway",
    async () => {
      const f = createFixture();
      const s = await f.open();
      const start = await s.capture();
      f.write("a.txt", "agent\n");
      f.write("locked/new.txt", "agent\n");
      const turn = await s.finishTurn(start);
      const plan = await s.planRevert([{ start, ...turn }]);
      // The checkout of a.txt works; deleting locked/new.txt can't.
      chmodSync(path.join(f.root, "locked"), 0o555);
      try {
        const error = await s.restore(plan.targets).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(RestoreError);
        const failed = error as RestoreError;
        expect(read(f.root, "a.txt")).toBe("a1\n");
        expect(failed.partial.restored).toEqual(["a.txt"]);
        expect(failed.partial.deleted).toEqual([]);

        chmodSync(path.join(f.root, "locked"), 0o755);
        await s.restore(
          plan.targets.map((t) => ({ ...t, tree: failed.redoTree })),
        );
        expect(read(f.root, "a.txt")).toBe("agent\n");
        expect(read(f.root, "locked/new.txt")).toBe("agent\n");
      } finally {
        chmodSync(path.join(f.root, "locked"), 0o755);
      }
    },
  );
});

describe("submodules", () => {
  it("lists a changed submodule pointer as skipped, not restored", async () => {
    const f = createFixture();
    const s = await f.open();
    const start = await s.capture();
    // An embedded repository the agent created or moved.
    f.write("sub/file.txt", "1\n");
    execFileSync("git", ["init", "-q"], {
      cwd: path.join(f.root, "sub"),
      env: f.env,
    });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "x",
      ],
      { cwd: path.join(f.root, "sub"), env: f.env },
    );
    const turn = await s.finishTurn(start);
    expect(turn.files).toEqual(["sub"]);
    const plan = await s.planRevert([{ start, ...turn }]);
    expect(plan.skipped).toEqual(["sub"]);
    expect(plan.delete).toEqual([]);
    expect(plan.targets).toEqual([]);
  });
});

describe("ignored files a turn writes", () => {
  function ignoring(pattern: string) {
    const f = createFixture();
    f.write(".gitignore", pattern + "\n");
    f.git("add", ".gitignore");
    f.git("commit", "-qm", "ignore");
    return f;
  }

  it("undoes and redoes an edit to an ignored file", async () => {
    const f = ignoring(".env");
    f.write(".env", "v1\n");
    const s = await f.open();
    const start = await s.capture();
    const turn = await s.preserve({ start }, [path.join(f.root, ".env")]);
    expect(turn.written).toEqual([".env"]);
    f.write(".env", "v2-agent\n");
    const end = await s.finishTurn(turn.start, undefined, turn.written);
    expect(end.files).toEqual([".env"]);

    const plan = await s.planRevert([{ ...turn, ...end }]);
    expect(plan.restore).toEqual([".env"]);
    const undone = await s.restore(plan.targets);
    expect(read(f.root, ".env")).toBe("v1\n");

    await s.restore(plan.targets.map((t) => ({ ...t, tree: undone.redoTree })));
    expect(read(f.root, ".env")).toBe("v2-agent\n");
  });

  it("deletes an ignored file the turn created, and keeps one it didn't write", async () => {
    const f = createFixture();
    const excludes = path.join(f.home, "excludes");
    writeFileSync(excludes, "*.log\n");
    f.git("config", "--global", "core.excludesFile", excludes);
    f.write("other.log", "person\n");
    const s = await f.open();
    const start = await s.capture();
    const turn = await s.preserve({ start }, ["debug.log"]);
    expect(turn.start).toBe(start);
    f.write("debug.log", "agent\n");
    f.write("other.log", "person 2\n");
    const end = await s.finishTurn(turn.start, undefined, turn.written);

    const plan = await s.planRevert([{ ...turn, ...end }]);
    expect(plan.delete).toEqual(["debug.log"]);
    const result = await s.restore(plan.targets);
    expect(result.deleted).toEqual(["debug.log"]);
    expect(existsSync(path.join(f.root, "debug.log"))).toBe(false);
    expect(read(f.root, "other.log")).toBe("person 2\n");
  });

  it("keeps the first version when a turn writes an ignored file twice", async () => {
    const f = ignoring(".env");
    f.write(".env", "v1\n");
    const s = await f.open();
    const start = await s.capture();
    let turn = await s.preserve({ start }, [".env"]);
    f.write(".env", "v2\n");
    turn = await s.preserve(turn, [".env"]);
    f.write(".env", "v3\n");
    const end = await s.finishTurn(turn.start, undefined, turn.written);
    await s.restore((await s.planRevert([{ ...turn, ...end }])).targets);
    expect(read(f.root, ".env")).toBe("v1\n");
  });

  it("leaves tracked files and paths outside the work tree to the captures", async () => {
    const f = createFixture();
    const s = await f.open();
    const start = await s.capture();
    const turn = await s.preserve({ start }, [
      "a.txt",
      "new.txt",
      path.join(tmpdir(), "x.txt"),
      ".git/config",
    ]);
    expect(turn).toEqual({ start, written: [] });
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

  it("undoes a top-level file whose name starts with two dots", async () => {
    const f = createFixture();
    f.write("..data", "v1\n");
    const s = await f.open();
    const start = await s.capture();
    f.write("..data", "v2\n");
    const turn = await s.finishTurn(start);

    const plan = await s.planRevert([{ start, ...turn }]);
    expect(plan.restore).toEqual(["..data"]);
    expect(plan.skipped).toEqual([]);
    await s.restore(plan.targets);
    expect(read(f.root, "..data")).toBe("v1\n");
  });

  it("refuses git metadata in any case or spelling, and leaves .git alone", async () => {
    const f = createFixture();
    const s = await f.open();
    const tree = await s.capture();
    const config = read(f.root, ".git/config");
    for (const file of [
      ".git/config",
      ".GIT/config",
      "sub/.Git/HEAD",
      ".git./config",
      "git~1/config",
      ".g\u200cit/config",
    ]) {
      await expect(s.restore([{ path: file, tree }])).rejects.toThrow(
        /git metadata/,
      );
    }
    expect(read(f.root, ".git/config")).toBe(config);
    const plan = await s.planRevert([{ start: tree, files: [".GIT/config"] }]);
    expect(plan.targets).toEqual([]);
    expect(plan.skipped).toEqual([".GIT/config"]);
    // Names that only look similar are ordinary files.
    f.write(".github/x.yml", "1\n");
    f.write(".gitignore", "\n");
    const start = await s.capture();
    f.write(".github/x.yml", "2\n");
    rmSync(path.join(f.root, ".gitignore"));
    await s.restore(
      (await s.planRevert([{ start, ...(await s.finishTurn(start)) }])).targets,
    );
    expect(read(f.root, ".github/x.yml")).toBe("1\n");
    expect(read(f.root, ".gitignore")).toBe("\n");
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
