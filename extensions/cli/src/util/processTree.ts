import { ChildProcess, spawnSync } from "child_process";

import { logger } from "./logger.js";

// Grace period between SIGTERM and SIGKILL when terminating a process tree
const KILL_GRACE_MS = 5000;

const isWindows = process.platform === "win32";

// Process trees started by tools that may still have live members. On POSIX
// these are process group ids (the shell's pid, since it is spawned detached).
const trackedTrees = new Set<number>();

/**
 * Spawn options that make the shell lead its own process group on POSIX, so
 * the whole tree, including backgrounded grandchildren, can be signaled at
 * once. Windows uses `taskkill /T` instead (detached would open a console).
 */
export function processTreeSpawnOptions(): { detached: boolean } {
  return { detached: !isWindows };
}

/**
 * Checks whether any process in the tree is still alive
 */
function isTreeAlive(pid: number): boolean {
  try {
    process.kill(isWindows ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sends a signal to every process in the tree rooted at `pid`
 */
export function signalProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!pid) return;

  if (isWindows) {
    // taskkill has no graceful mode for console processes; /F is required
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    // Not a group leader (or the group is gone): fall back to the pid itself
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited
    }
  }
}

/**
 * Terminates a process tree: SIGTERM now, SIGKILL after a grace period if
 * anything in the tree is still alive.
 */
export function killProcessTree(child: ChildProcess | number): void {
  const pid = typeof child === "number" ? child : child.pid;
  if (!pid) return;

  signalProcessTree(pid, "SIGTERM");
  if (isWindows) return;

  const timer = setTimeout(() => {
    if (isTreeAlive(pid)) {
      signalProcessTree(pid, "SIGKILL");
    }
    trackedTrees.delete(pid);
  }, KILL_GRACE_MS);
  timer.unref();
}

/**
 * Registers a spawned shell so its tree is killed when the CLI exits
 */
export function trackProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  trackedTrees.add(pid);

  child.once("exit", () => {
    // On Windows the tree can't be found once the root exits. On POSIX keep
    // the group while backgrounded members are alive, so they can still be
    // killed at exit; forget it once empty so a reused pid is never signaled.
    if (isWindows || !isTreeAlive(pid)) {
      trackedTrees.delete(pid);
    }
  });
}

/**
 * Signals every tracked process tree. Called on exit with SIGTERM, then
 * SIGKILL just before the process exits.
 */
export function signalAllProcessTrees(signal: NodeJS.Signals): void {
  for (const pid of trackedTrees) {
    if (!isWindows && !isTreeAlive(pid)) {
      trackedTrees.delete(pid);
      continue;
    }
    logger.debug(`Sending ${signal} to process tree ${pid}`);
    signalProcessTree(pid, signal);
  }
  if (signal === "SIGKILL") {
    trackedTrees.clear();
  }
}
