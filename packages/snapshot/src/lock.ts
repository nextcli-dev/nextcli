import { promises as fs } from "node:fs";

const STALE_MS = 10 * 60 * 1000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function isStale(lockPath: string): Promise<boolean> {
  try {
    const [content, stat] = await Promise.all([
      fs.readFile(lockPath, "utf8"),
      fs.stat(lockPath),
    ]);
    const pid = Number.parseInt(content, 10);
    if (Date.now() - stat.mtimeMs > STALE_MS) return true;
    return Number.isInteger(pid) && pid !== process.pid && !isAlive(pid);
  } catch {
    // Gone already, or unreadable while another process writes it.
    return false;
  }
}

/**
 * A lock file shared by every process that uses the same snapshot store, so
 * two `cn` sessions (or `cn` and the extension) never interleave a capture
 * with a restore. A lock left by a process that died is taken over.
 */
export class StoreLock {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly lockPath: string,
    private readonly timeoutMs = 60_000,
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    // Serialise callers in this process first; the file only guards
    // against other processes.
    const next = this.queue.then(() => this.withFile(task));
    this.queue = next.catch(() => {});
    return next;
  }

  private async withFile<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      await fs.rm(this.lockPath, { force: true });
    }
  }

  private async acquire(): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      try {
        await fs.writeFile(this.lockPath, String(process.pid), { flag: "wx" });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (await isStale(this.lockPath)) {
        await fs.rm(this.lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for snapshot lock ${this.lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
