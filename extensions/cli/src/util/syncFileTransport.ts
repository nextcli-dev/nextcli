import fs from "fs";
import path from "path";

import Transport from "winston-transport";

// winston keeps the formatted line under this symbol (triple-beam's MESSAGE)
const MESSAGE = Symbol.for("message");

export interface SyncFileTransportOptions {
  filename: string;
  /** Rotate when the file would grow past this many bytes */
  maxsize: number;
  /** Files kept, the current one included: cn.log, cn1.log, ... */
  maxFiles: number;
}

/**
 * A winston transport that writes each line to the file before it returns.
 * winston's File transport buffers lines in streams, and process.exit(),
 * which every cn exit path ends with, drops what is still buffered: at trace
 * level, the end of a run. A synchronous write costs a few microseconds per
 * line, and trace (a line per stream chunk) is opt-in.
 */
export class SyncFileTransport extends Transport {
  private fd: number | undefined;
  private size = 0;

  constructor(private readonly options: SyncFileTransportOptions) {
    super();
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
    for (let index = this.options.maxFiles - 1; index >= 1; index--) {
      const from =
        index === 1 ? this.options.filename : this.rotatedPath(index - 1);
      if (fs.existsSync(from)) fs.renameSync(from, this.rotatedPath(index));
    }
  }

  log(info: Record<string | symbol, unknown>, callback: () => void): void {
    const line = `${String(info[MESSAGE])}\n`;
    try {
      const bytes = Buffer.byteLength(line);
      let fd = this.fd ?? this.open();
      if (this.size > 0 && this.size + bytes > this.options.maxsize) {
        this.rotate();
        fd = this.open();
      }
      fs.writeSync(fd, line);
      this.size += bytes;
    } catch {
      // A log line that can't be written must never stop the CLI
    }
    callback();
  }

  close(): void {
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = undefined;
  }
}
