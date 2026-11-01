import { ChildProcess, spawnSync } from "child_process";

import { logger } from "./logger.js";

// Grace period between SIGTERM and SIGKILL when terminating a process tree
const KILL_GRACE_MS = 5000;

const isWindows = process.platform === "win32";

interface TrackedTree {
  // A tool call is waiting on this tree. Terminal signals (Ctrl+C, Ctrl+Z)
  // are forwarded to it, because the detached shell doesn't receive them.
  foreground: boolean;
  // Lets Windows tell the root's real descendants from processes that later
  // reused a pid
  startedAt: number;
}

// Process trees started by tools that may still have live members, by root
// pid. On POSIX the root pid is also the process group id, because the shell
// is spawned detached.
const trackedTrees = new Map<number, TrackedTree>();

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
 * Finds the live descendants of Windows process trees, including those whose
 * root already exited: Windows keeps the parent pid of orphans, and the
 * creation time rules out processes that reused a pid.
 */
function findWindowsDescendants(roots: Map<number, TrackedTree>): number[] {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $([DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds())" }',
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15000 },
  );
  if (result.status !== 0 || !result.stdout) return [];

  const processes = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(" ").map(Number))
    .filter((fields) => fields.length === 3 && fields.every(Number.isFinite));

  const found: number[] = [];
  const queue = [...roots.entries()].map(([pid, tree]) => ({
    pid,
    startedAt: tree.startedAt,
  }));
  const seen = new Set(queue.map(({ pid }) => pid));
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const [pid, parentPid, createdAt] of processes) {
      // Allow a little clock slack between Node and WMI
      if (
        parentPid === parent.pid &&
        createdAt >= parent.startedAt - 1000 &&
        !seen.has(pid)
      ) {
        seen.add(pid);
        found.push(pid);
        queue.push({ pid, startedAt: createdAt });
      }
    }
  }
  return found;
}

function taskkill(pid: number): void {
  // taskkill has no graceful mode for console processes; /F is required
  spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
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
    // Only termination exists on Windows
    if (signal !== "SIGTERM" && signal !== "SIGKILL" && signal !== "SIGINT") {
      return;
    }
    const tree = trackedTrees.get(pid);
    if (isTreeAlive(pid)) {
      taskkill(pid);
    } else if (tree) {
      // The root exited; its backgrounded children can still be found
      for (const descendant of findWindowsDescendants(new Map([[pid, tree]]))) {
        taskkill(descendant);
      }
    }
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
  if (isWindows) {
    trackedTrees.delete(pid);
    return;
  }

  const timer = setTimeout(() => {
    if (isTreeAlive(pid)) {
      signalProcessTree(pid, "SIGKILL");
    }
    trackedTrees.delete(pid);
  }, KILL_GRACE_MS);
  timer.unref();
}

/**
 * Registers a spawned shell so its tree is killed when the CLI exits. A
 * foreground tree also receives forwarded terminal signals until
 * releaseForeground() is called.
 */
export function trackProcessTree(
  child: ChildProcess,
  { foreground = false }: { foreground?: boolean } = {},
): void {
  const pid = child.pid;
  if (!pid) return;
  trackedTrees.set(pid, { foreground, startedAt: Date.now() });

  child.once("exit", () => {
    // Keep the tree while backgrounded members may be alive, so they can still
    // be killed at exit. On POSIX, forget an empty group so a reused pid is
    // never signaled. Windows can't tell, and matches by creation time instead.
    if (!isWindows && !isTreeAlive(pid)) {
      trackedTrees.delete(pid);
    }
  });
}

/**
 * Stops forwarding terminal signals to a tree: its tool call has finished or
 * moved to the background. The tree is still killed when the CLI exits.
 */
export function releaseForeground(child: ChildProcess): void {
  const tree = child.pid ? trackedTrees.get(child.pid) : undefined;
  if (tree) {
    tree.foreground = false;
  }
}

/**
 * Forwards a terminal signal (SIGINT, SIGSTOP, SIGCONT) to the trees of
 * running tool calls. Their shells run in their own process group, so the
 * terminal only signals the CLI itself.
 */
export function signalForegroundProcessTrees(signal: NodeJS.Signals): void {
  for (const [pid, tree] of trackedTrees) {
    if (tree.foreground) {
      logger.debug(`Forwarding ${signal} to process tree ${pid}`);
      signalProcessTree(pid, signal);
    }
  }
}

/**
 * Signals every tracked process tree. Called on exit with SIGTERM, then
 * SIGKILL just before the process exits.
 */
export function signalAllProcessTrees(signal: NodeJS.Signals): void {
  if (isWindows) {
    // taskkill is already forceful: one pass kills everything, including
    // children of shells that have exited
    if (trackedTrees.size === 0) return;
    const descendants = findWindowsDescendants(trackedTrees);
    for (const pid of [...trackedTrees.keys(), ...descendants]) {
      if (isTreeAlive(pid)) taskkill(pid);
    }
    trackedTrees.clear();
    return;
  }

  for (const pid of trackedTrees.keys()) {
    if (!isTreeAlive(pid)) {
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
