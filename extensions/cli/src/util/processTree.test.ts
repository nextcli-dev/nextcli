import { execFileSync, spawn } from "child_process";

import { describe, expect, it } from "vitest";

import {
  processTreeSpawnOptions,
  releaseForeground,
  signalAllProcessTrees,
  signalForegroundProcessTrees,
  trackProcessTree,
} from "./processTree.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean): Promise<boolean> {
  for (let i = 0; i < 50 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

function spawnTree() {
  const child = spawn("/bin/sh", ["-c", "sleep 30"], {
    stdio: "ignore",
    ...processTreeSpawnOptions(),
  });
  return child;
}

/**
 * A child in its own process group that handles SIGINT itself and says when
 * it's ready. Handling it overrides an inherited "ignore SIGINT" (as CI
 * runners can set), and waiting for "ready" avoids signalling before the
 * child has set up its process group.
 */
async function spawnReadyChild() {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.on("SIGINT", () => process.exit(130)); console.log("ready"); setInterval(() => {}, 1000);',
    ],
    { stdio: ["ignore", "pipe", "ignore"], ...processTreeSpawnOptions() },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (data: Buffer) => {
      if (data.toString().includes("ready")) resolve();
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("child exited early")));
  });
  return child;
}

// PR #7 review: the shell runs in its own session, so terminal Ctrl+C and
// Ctrl+Z reach only the CLI, which must forward them to the running command
describe.skipIf(process.platform === "win32")(
  "terminal signal forwarding",
  () => {
    it("forwards SIGINT to a foreground tree", async () => {
      const child = await spawnReadyChild();
      trackProcessTree(child, { foreground: true });

      signalForegroundProcessTrees("SIGINT");

      expect(
        await waitFor(
          () => child.exitCode !== null || child.signalCode !== null,
        ),
      ).toBe(true);
      // 130 means the child's SIGINT handler ran
      expect(child.exitCode).toBe(130);
    });

    it("does not forward to a released or background tree", async () => {
      const released = spawnTree();
      trackProcessTree(released, { foreground: true });
      releaseForeground(released);
      const background = spawnTree();
      trackProcessTree(background);

      signalForegroundProcessTrees("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(isAlive(released.pid!)).toBe(true);
      expect(isAlive(background.pid!)).toBe(true);

      signalAllProcessTrees("SIGKILL");
      expect(await waitFor(() => !isAlive(released.pid!))).toBe(true);
      expect(await waitFor(() => !isAlive(background.pid!))).toBe(true);
    });

    it("stops and resumes a foreground tree with SIGSTOP and SIGCONT", async () => {
      const child = spawnTree();
      trackProcessTree(child, { foreground: true });
      // The shell execs sleep, so the pid is the sleeping process
      const state = () =>
        execFileSync("ps", ["-o", "stat=", "-p", String(child.pid)])
          .toString()
          .trim();
      await new Promise((resolve) => setTimeout(resolve, 200));

      // What the CLI's SIGTSTP handler forwards; SIGTSTP itself is ignored in
      // an orphaned process group
      signalForegroundProcessTrees("SIGSTOP");
      expect(await waitFor(() => state().startsWith("T"))).toBe(true);

      signalForegroundProcessTrees("SIGCONT");
      expect(await waitFor(() => !state().startsWith("T"))).toBe(true);

      signalAllProcessTrees("SIGKILL");
      expect(await waitFor(() => !isAlive(child.pid!))).toBe(true);
    });
  },
);
