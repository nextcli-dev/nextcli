import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

export interface StoreLockOptions {
  /** How long to wait for another process before giving up. */
  timeoutMs?: number;
  /**
   * A lock file with no readable pid that nobody refreshed for this long is
   * taken over. A lock with a live pid never is.
   */
  staleMs?: number;
  /** How often the holder refreshes the lock's mtime. */
  heartbeatMs?: number;
}

const DEFAULT_STALE_MS = 10 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 30 * 1000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock's content, or undefined if it is gone. */
async function readLock(lockPath: string): Promise<string | undefined> {
  return fs.readFile(lockPath, "utf8").catch(() => undefined);
}

/** Removes the lock only if it still holds `content`. */
async function removeIfUnchanged(
  lockPath: string,
  content: string,
): Promise<void> {
  // Another process can replace the file between the read and the unlink.
  // The window is a few microseconds; the content check keeps a lock taken
  // over long ago (or never ours) from being removed.
  if ((await readLock(lockPath)) === content) {
    await fs.rm(lockPath, { force: true });
  }
}

/**
 * A lock file shared by every process that uses the same snapshot store, so
 * two `cn` sessions (or `cn` and the extension) never interleave a capture
 * with a restore.
 *
 * The file holds `<pid> <token>`. It is taken over only when that process is
 * dead, however long the holder runs: `git add` on a large work tree, or a
 * laptop that slept mid-capture, must not lose the lock. While it is held
 * its mtime is refreshed, so a file without a readable pid (a crash between
 * creating and writing it) is taken over once nobody has touched it for
 * `staleMs`. Release removes the file only if it still holds this holder's
 * token, so a holder never removes a lock someone else took over.
 */
export class StoreLock {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly timeoutMs: number;
  private readonly staleMs: number;
  private readonly heartbeatMs: number;

  constructor(
    private readonly lockPath: string,
    options: StoreLockOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    // Serialise callers in this process first; the file only guards
    // against other processes.
    const next = this.queue.then(() => this.withFile(task));
    this.queue = next.catch(() => {});
    return next;
  }

  private async withFile<T>(task: () => Promise<T>): Promise<T> {
    const content = `${process.pid} ${randomUUID()}`;
    await this.acquire(content);
    const heartbeat = setInterval(() => {
      const now = new Date();
      fs.utimes(this.lockPath, now, now).catch(() => {});
    }, this.heartbeatMs);
    heartbeat.unref();
    try {
      return await task();
    } finally {
      clearInterval(heartbeat);
      await removeIfUnchanged(this.lockPath, content);
    }
  }

  private async acquire(content: string): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      try {
        await fs.writeFile(this.lockPath, content, { flag: "wx" });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stale = await this.staleContent();
      if (stale !== undefined) {
        await removeIfUnchanged(this.lockPath, stale);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for snapshot lock ${this.lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** The content of the lock file if it may be taken over. */
  private async staleContent(): Promise<string | undefined> {
    try {
      const [content, stat] = await Promise.all([
        fs.readFile(this.lockPath, "utf8"),
        fs.stat(this.lockPath),
      ]);
      const pid = Number.parseInt(content, 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        // Half-written by a process that is creating it right now, or
        // garbage. Only age makes it stale.
        return Date.now() - stat.mtimeMs > this.staleMs ? content : undefined;
      }
      // A live pid keeps the lock, however old the file looks. If the pid was
      // reused by an unrelated process, waiting times out with an error that
      // names the lock file rather than risking two holders.
      return pid !== process.pid && !isAlive(pid) ? content : undefined;
    } catch {
      // Gone already.
      return undefined;
    }
  }
}
