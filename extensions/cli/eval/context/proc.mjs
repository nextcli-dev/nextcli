// Running cn and the checks: capture output, stop at a timeout, and leave no
// process behind. cn starts each Bash command detached, in its own process
// group, so killing cn alone (or cn's group) would leave a hung command
// running in the project while the check and the probes read it.
import { spawn, spawnSync } from "node:child_process";

const live = new Set();

/** Process ids under `pid`, deepest first (POSIX) */
function descendants(pid) {
  const listing =
    spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).stdout ??
    "";
  const children = new Map();
  for (const line of listing.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child && parent) {
      children.set(parent, [...(children.get(parent) ?? []), child]);
    }
  }
  const found = [];
  const pending = [pid];
  while (pending.length) {
    for (const child of children.get(pending.pop()) ?? []) {
      found.push(child);
      pending.push(child);
    }
  }
  return found.reverse();
}

/**
 * Kills a process and everything it started, before the process itself:
 * once it is gone its children are re-parented and can't be found.
 */
export function killTree(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    return;
  }
  for (const target of [...descendants(pid), pid]) {
    // Its process group, when it leads one: a detached Bash command does
    try {
      process.kill(-target, "SIGKILL");
    } catch {
      // not a group leader
    }
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Kills every command still running, when the runner is interrupted */
export function killAll() {
  for (const child of live) killTree(child.pid);
  live.clear();
}

/** Runs a command, capturing output; never rejects */
export function exec(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    live.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, timeoutMs)
      : null;
    const finish = (code, error) => {
      clearTimeout(timer);
      live.delete(child);
      resolve({
        code: timedOut ? null : code,
        stdout,
        stderr: error ? String(error) : stderr,
        timedOut,
        ms: Date.now() - started,
      });
    };
    child.on("close", (code) => finish(code));
    child.on("error", (error) => finish(null, error));
  });
}
