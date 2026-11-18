import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { SnapshotManager } from "./SnapshotManager";

function setup() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "core-undo-")));
  const repo = path.join(base, "repo");
  const plain = path.join(base, "plain");
  mkdirSync(plain);
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(path.join(repo, "a.txt"), "a1\n");
  const dirs = [
    pathToFileURL(repo).toString(),
    // A second folder of the same repository shares its snapshots.
    pathToFileURL(repo).toString() + "/",
    pathToFileURL(plain).toString(),
    "vscode-remote://ssh-remote+host/home/project",
  ];
  const manager = new SnapshotManager(
    async () => dirs,
    () => path.join(base, "store"),
  );
  return { repo, manager };
}

describe("SnapshotManager", () => {
  it("snapshots only local git work trees, once each", async () => {
    const { repo, manager } = setup();
    const { roots } = await manager.capture("session/1");
    expect(roots).toEqual([{ root: repo, tree: expect.any(String) }]);
  });

  it("undoes and redoes a turn through the protocol shapes", async () => {
    const { repo, manager } = setup();
    const { roots } = await manager.capture("session/1");
    const started = {
      v: 1 as const,
      roots: roots.map((r) => ({ root: r.root, start: r.tree })),
    };
    writeFileSync(path.join(repo, "a.txt"), "a2\n");
    writeFileSync(path.join(repo, "b.txt"), "b\n");
    const checkpoint = await manager.finishTurn(started, "session/1");
    expect(checkpoint.roots[0].files?.sort()).toEqual(["a.txt", "b.txt"]);

    const { roots: plans } = await manager.planRevert([checkpoint]);
    expect(plans[0].plan.restore).toEqual(["a.txt"]);
    expect(plans[0].plan.delete).toEqual(["b.txt"]);

    const undone = await manager.restore({
      roots: plans.map((p) => ({ root: p.root, targets: p.plan.targets })),
    });
    expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("a1\n");
    expect(existsSync(path.join(repo, "b.txt"))).toBe(false);

    const { result } = undone.roots[0];
    await manager.restore({
      roots: [
        {
          root: repo,
          targets: plans[0].plan.targets.map((t) => ({
            path: t.path,
            tree: result.redoTree,
          })),
        },
      ],
    });
    expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("a2\n");
    expect(readFileSync(path.join(repo, "b.txt"), "utf8")).toBe("b\n");
  });

  it("refuses to restore a work tree that is no longer open", async () => {
    const { manager } = setup();
    await expect(
      manager.planRevert([{ v: 1, roots: [{ root: "/gone", start: "x" }] }]),
    ).rejects.toThrow(/no longer open/);
  });
});
