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
import { escapeExcludePath } from "../../src/snapshot/capture.js";
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

describe("openSnapshotter", () => {
  it("is disabled outside a git repository", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cn-snapshot-nogit-"));
    const result = await openSnapshotter({
      cwd: dir,
      storeRoot: path.join(dir, "store"),
      env: { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    expect(result).toMatchObject({ ok: false, reason: "not-a-git-repo" });
  });

  it("is disabled when git can't be run", async () => {
    const f = createFixture();
    const result = await openSnapshotter({
      cwd: f.root,
      storeRoot: f.storeRoot,
      gitBinary: path.join(f.home, "no-such-git"),
    });
    expect(result).toMatchObject({ ok: false, reason: "git-not-found" });
  });

  it("snapshots the whole repository from a subdirectory", async () => {
    const f = createFixture();
    f.write("sub/c.txt", "c1\n");
    const result = await openSnapshotter({
      cwd: path.join(f.root, "sub"),
      storeRoot: f.storeRoot,
      env: f.env,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.snapshotter.toplevel).toBe(f.root);
  });
});

describe("what a snapshot contains", () => {
  it("leaves out large untracked files but keeps large tracked ones", async () => {
    const f = createFixture();
    f.write("tracked.bin", "x".repeat(5000));
    f.git("add", "tracked.bin");
    f.git("commit", "-qm", "big");
    f.write("untracked.bin", "y".repeat(5000));
    f.write("small.txt", "s\n");
    const s = await f.open({ maxUntrackedFileBytes: 1000 });
    const tree = await s.capture();

    const listed = storeGit(
      s.storeDir,
      f.root,
      "ls-tree",
      "-r",
      "--name-only",
      tree,
    );
    expect(listed).toContain("tracked.bin");
    expect(listed).toContain("small.txt");
    expect(listed).not.toContain("untracked.bin");
  });

  it("never runs filters or hooks from the project or the person's config", async () => {
    const f = createFixture();
    const marker = path.join(f.home, "filter-ran");
    const command = `touch '${marker}' && cat`;
    f.git("config", "filter.evil.clean", command);
    writeFileSync(
      path.join(f.home, ".gitconfig"),
      `[filter "evil"]\n\tclean = ${command}\n[core]\n\tfsmonitor = touch '${marker}'\n`,
    );
    f.write(".gitattributes", "* filter=evil\n");
    f.write("a.txt", "changed\n");

    const s = await f.open();
    await s.capture();
    expect(existsSync(marker)).toBe(false);
  });

  it("doesn't snapshot its own store when it lives inside the work tree", async () => {
    const f = createFixture();
    const result = await openSnapshotter({
      cwd: f.root,
      storeRoot: path.join(f.root, ".continue", "snapshots"),
      env: f.env,
    });
    if (!result.ok) throw new Error(result.reason);
    const tree = await result.snapshotter.capture();
    const listed = storeGit(
      result.snapshotter.storeDir,
      f.root,
      "ls-tree",
      "-r",
      "--name-only",
      tree,
    );
    expect(listed).not.toContain(".continue/snapshots");
  });
});

describe("prune", () => {
  it("keeps recent snapshots restorable through a full gc", async () => {
    const f = createFixture();
    f.write("u.txt", "untracked v1\n");
    const s = await f.open();
    const start = await s.capture("s/1/start");
    f.write("u.txt", "untracked v2\n");
    const turn = await s.finishTurn(start, "s/1/end");

    const result = await s.prune({ force: true });
    expect(result).toEqual({ deletedRefs: 0, ran: true });
    storeGit(s.storeDir, f.root, "gc", "--quiet", "--prune=now");

    await s.restore((await s.planRevert([{ start, ...turn }])).targets);
    expect(read(f.root, "u.txt")).toBe("untracked v1\n");
  });

  it("deletes snapshots older than the limit, once a day", async () => {
    const f = createFixture();
    const s = await f.open();
    await s.capture("s/1/start");
    await s.capture("s/1/end");
    const later = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);

    expect(await s.prune({ now: later })).toEqual({
      deletedRefs: 2,
      ran: true,
    });
    expect(await s.prune({ now: later })).toEqual({
      deletedRefs: 0,
      ran: false,
    });
    expect(
      storeGit(s.storeDir, f.root, "for-each-ref", "refs/cn/").trim(),
    ).toBe("");
  });
});

describe("escapeExcludePath", () => {
  it("escapes glob characters and trailing spaces", () => {
    expect(escapeExcludePath("a*b?[c]!#\\d  ")).toBe(
      "a\\*b\\?\\[c\\]\\!\\#\\\\d\\ \\ ",
    );
  });
});
