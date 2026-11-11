import fs from "fs";
import path from "path";

import Transport from "winston-transport";

// winston keeps the formatted line and the uncolored level under these
// symbols (triple-beam's MESSAGE and LEVEL)
const MESSAGE = Symbol.for("message");
const LEVEL = Symbol.for("level");

const FLUSH_INTERVAL_MS = 100;
const MAX_BUFFER_BYTES = 64 * 1024;

export interface BufferedFileTransportOptions {
  filename: string;
  /** Rotate when the file would grow past this many bytes */
  maxsize: number;
  /** Files kept, the current one included: cn.log, cn1.log, ... */
  maxFiles: number;
}

/**
 * A winston transport that buffers lines in memory and writes them
 * synchronously, one write per file (a flush that crosses maxsize writes once
 * per rotated file): after FLUSH_INTERVAL_MS, when MAX_BUFFER_BYTES are
 * buffered, on an error line, and on process exit.
 *
 * winston's File transport buffers in streams that process.exit(), which
 * every cn exit path ends with, drops. Node runs "exit" listeners
 * synchronously inside process.exit() and after an uncaught exception, so the
 * flush here covers every exit path. Only a hard kill (SIGKILL, an OOM abort)
 * can lose the last FLUSH_INTERVAL_MS of lines. Batching keeps trace level, a
 * line per stream chunk, from making a syscall per line.
 */
export class BufferedFileTransport extends Transport {
  private fd: number | undefined;
  private size = 0;
  private pending: string[] = [];
  private pendingBytes = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly flushNow = () => this.flush();

  constructor(private readonly options: BufferedFileTransportOptions) {
    super();
    process.on("exit", this.flushNow);
  }

  log(info: Record<string | symbol, unknown>, callback: () => void): void {
    const line = `${String(info[MESSAGE])}\n`;
    this.pending.push(line);
    this.pendingBytes += Buffer.byteLength(line);

    if (this.pendingBytes >= MAX_BUFFER_BYTES || info[LEVEL] === "error") {
      this.flush();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(this.flushNow, FLUSH_INTERVAL_MS);
      // A pending flush must not keep the process alive; exit flushes anyway
      this.timer.unref();
    }
    callback();
  }

  /** Writes the buffered lines, rotating the file where a line would cross maxsize */
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.length === 0) return;

    const lines = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    try {
      let fd = this.fd ?? this.open();
      let start = 0;
      let chunkBytes = 0;
      for (let i = 0; i < lines.length; i++) {
        const bytes = Buffer.byteLength(lines[i]);
        const fileBytes = this.size + chunkBytes;
        if (fileBytes > 0 && fileBytes + bytes > this.options.maxsize) {
          if (chunkBytes > 0) fs.writeSync(fd, lines.slice(start, i).join(""));
          this.rotate();
          fd = this.open();
          start = i;
          chunkBytes = 0;
        }
        chunkBytes += bytes;
      }
      fs.writeSync(fd, lines.slice(start).join(""));
      this.size += chunkBytes;
    } catch {
      // Log lines that can't be written must never stop the CLI
    }
  }

  close(): void {
    this.flush();
    process.off("exit", this.flushNow);
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = undefined;
  }

  private rotatedPath(index: number): string {
    const { dir, name, ext } = path.parse(this.options.filename);
    return path.join(dir, `${name}${index}${ext}`);
  }

  private open(): number {
    const fd = fs.openSync(this.options.filename, "a");
    this.fd = fd;
    this.size = fs.fstatSync(fd).size;
    return fd;
  }

  // cn.log becomes cn1.log, cn1.log becomes cn2.log, and the oldest is dropped
  private rotate(): void {
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = undefined;
    // With no older files kept, start the current file over
    if (this.options.maxFiles <= 1) {
      fs.rmSync(this.options.filename, { force: true });
      return;
    }
    for (let index = this.options.maxFiles - 1; index >= 1; index--) {
      const from =
        index === 1 ? this.options.filename : this.rotatedPath(index - 1);
      if (fs.existsSync(from)) fs.renameSync(from, this.rotatedPath(index));
    }
  }
}
