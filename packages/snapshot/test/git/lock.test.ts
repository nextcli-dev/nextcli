import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StoreLock } from "../../src/git/lock.js";

const children: { kill(): void }[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

function lockPath(): string {
  return path.join(
    mkdtempSync(path.join(tmpdir(), "cn-lock-")),
    "nextcli.lock",
  );
}

function livePid(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  children.push(child);
  return child.pid!;
}

function deadPid(): number {
  return spawnSync(process.execPath, ["-e", "0"]).pid!;
}

function age(file: string, minutes: number): void {
  const then = new Date(Date.now() - minutes * 60 * 1000);
  utimesSync(file, then, then);
}

describe("StoreLock", () => {
  it("never takes over a lock whose process is alive, however old", async () => {
    const file = lockPath();
    writeFileSync(file, `${livePid()} other`);
    age(file, 11);

    const lock = new StoreLock(file, { timeoutMs: 300 });
    let ran = false;
    await expect(
      lock.run(async () => {
        ran = true;
      }),
    ).rejects.toThrow(/Timed out/);
    expect(ran).toBe(false);
    expect(readFileSync(file, "utf8")).toMatch(/ other$/);
  });

  it("takes over a lock whose process is dead, then releases it", async () => {
    const file = lockPath();
    writeFileSync(file, `${deadPid()} other`);

    const lock = new StoreLock(file, { timeoutMs: 2000 });
    const held = await lock.run(async () => readFileSync(file, "utf8"));
    expect(held.startsWith(`${process.pid} `)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("takes over an unreadable lock only once it is old", async () => {
    const file = lockPath();
    writeFileSync(file, "");
    const lock = new StoreLock(file, { timeoutMs: 200, staleMs: 60_000 });
    await expect(lock.run(async () => {})).rejects.toThrow(/Timed out/);

    age(file, 2);
    await expect(lock.run(async () => "ran")).resolves.toBe("ran");
  });

  it("doesn't remove a lock that another holder took over", async () => {
    const file = lockPath();
    const lock = new StoreLock(file);
    await lock.run(async () => {
      writeFileSync(file, `${livePid()} someone-else`);
    });
    expect(readFileSync(file, "utf8")).toMatch(/ someone-else$/);
  });

  it("keeps the lock fresh while the holder works", async () => {
    const file = lockPath();
    const lock = new StoreLock(file, { heartbeatMs: 20 });
    const mtime = await lock.run(async () => {
      age(file, 30);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return statSync(file).mtimeMs;
    });
    expect(Date.now() - mtime).toBeLessThan(60_000);
  });

  it("makes a second process wait for a long-running holder", async () => {
    const file = lockPath();
    const first = new StoreLock(file, { heartbeatMs: 20 });
    const second = new StoreLock(file, { timeoutMs: 5000 });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const holding = first.run(async () => {
      order.push("first:start");
      // The file looks long abandoned, but its holder is alive.
      age(file, 11);
      await gate;
      order.push("first:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const waiting = second.run(async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await Promise.all([holding, waiting]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});
