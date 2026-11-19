import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

export interface StoreLockOptions {
  timeoutMs?: number;
  /** Only for a lock without a readable pid; a live pid is never taken over. */
  staleMs?: number;
  heartbeatMs?: number;
}

const DEFAULT_STALE_MS = 10 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 30 * 1000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, owned by another user
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(lockPath: string): Promise<string | undefined> {
  return fs.readFile(lockPath, "utf8").catch(() => undefined);
}

/** Best effort: the read and the removal are not one atomic step. */
async function removeIfUnchanged(
  lockPath: string,
  content: string,
): Promise<void> {
  if ((await readLock(lockPath)) === content) {
    await fs.rm(lockPath, { force: true });
  }
}

/**
 * Serialises store access across processes (`cn` sessions, the extension).
 * The file holds `<pid> <token>`. A live pid keeps it however long it runs;
 * a dead pid loses it, and one without a readable pid only after `staleMs`.
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

  private async staleContent(): Promise<string | undefined> {
    try {
      const [content, stat] = await Promise.all([
        fs.readFile(this.lockPath, "utf8"),
        fs.stat(this.lockPath),
      ]);
      const pid = Number.parseInt(content, 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        // Being written right now, or garbage: only age makes it stale
        return Date.now() - stat.mtimeMs > this.staleMs ? content : undefined;
      }
      // A reused pid makes us time out rather than risk two holders
      return pid !== process.pid && !isAlive(pid) ? content : undefined;
    } catch {
      return undefined;
    }
  }
}
