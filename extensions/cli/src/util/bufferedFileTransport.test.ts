import { spawnSync } from "child_process";
import fs from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import winston from "winston";

import { BufferedFileTransport } from "./bufferedFileTransport.js";

const transportUrl = pathToFileURL(
  fileURLToPath(new URL("./bufferedFileTransport.ts", import.meta.url)),
).href;
const winstonUrl = pathToFileURL(
  createRequire(import.meta.url).resolve("winston"),
).href;
const cliDir = fileURLToPath(new URL("../..", import.meta.url));

describe("BufferedFileTransport", () => {
  let dir: string;
  let file: string;
  let transport: BufferedFileTransport | undefined;

  const loggerWith = (options: { maxsize: number; maxFiles: number }) => {
    transport = new BufferedFileTransport({ filename: file, ...options });
    return winston.createLogger({
      format: winston.format.printf(({ message }) => String(message)),
      transports: [transport],
    });
  };
  const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf-8");
  const readOrEmpty = (name: string) =>
    fs.existsSync(path.join(dir, name)) ? read(name) : "";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-log-"));
    file = path.join(dir, "cn.log");
  });

  afterEach(() => {
    vi.useRealTimers();
    transport?.close();
    transport = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes buffered lines after the flush interval", () => {
    vi.useFakeTimers();
    const logger = loggerWith({ maxsize: 10_000_000, maxFiles: 5 });

    logger.info("first");
    logger.info("second");
    expect(readOrEmpty("cn.log")).toBe("");

    vi.advanceTimersByTime(100);
    expect(read("cn.log")).toBe("first\nsecond\n");
  });

  it("writes at once when 64 KiB are buffered", () => {
    vi.useFakeTimers();
    const logger = loggerWith({ maxsize: 10_000_000, maxFiles: 5 });
    const line = "x".repeat(1023); // 1 KiB with the newline

    for (let i = 0; i < 64; i++) logger.info(line);

    expect(read("cn.log")).toHaveLength(64 * 1024);
  });

  it("writes an error line, and the lines before it, at once", () => {
    vi.useFakeTimers();
    const logger = loggerWith({ maxsize: 10_000_000, maxFiles: 5 });

    logger.info("before");
    logger.error("failed");

    expect(read("cn.log")).toBe("before\nfailed\n");
  });

  it("appends to an existing log", () => {
    fs.writeFileSync(file, "earlier run\n");
    loggerWith({ maxsize: 10_000_000, maxFiles: 5 }).info("this run");
    transport?.close();

    expect(read("cn.log")).toBe("earlier run\nthis run\n");
  });

  it("rotates at the size limit and keeps maxFiles files", () => {
    const logger = loggerWith({ maxsize: 20, maxFiles: 3 });

    // Each line is 10 bytes, so every file holds two, even within one flush
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) logger.info(`line ${n}...`);
    transport?.close();

    expect(read("cn.log")).toBe("line 7...\nline 8...\n");
    expect(read("cn1.log")).toBe("line 5...\nline 6...\n");
    expect(read("cn2.log")).toBe("line 3...\nline 4...\n");
    expect(fs.existsSync(path.join(dir, "cn3.log"))).toBe(false);
  });

  it("doesn't throw when the file can't be written", () => {
    file = path.join(dir, "missing-dir", "cn.log");
    const logger = loggerWith({ maxsize: 10_000_000, maxFiles: 5 });

    expect(() => {
      logger.info("lost");
      logger.error("lost too");
      transport?.close();
    }).not.toThrow();
  });

  // Every cn exit path ends in process.exit(), which skips timers and
  // streams, so the tail of a run must be written by the exit listener
  describe.each([
    ["process.exit()", "process.exit(0);", 0],
    ["an uncaught exception", 'throw new Error("crash");', 1],
  ])("on %s", (_name, ending, exitCode) => {
    it("keeps every line", () => {
      const script = path.join(dir, "probe.mts");
      fs.writeFileSync(
        script,
        `import winston from ${JSON.stringify(winstonUrl)};
import { BufferedFileTransport } from ${JSON.stringify(transportUrl)};
const logger = winston.createLogger({
  format: winston.format.printf(({ message }) => String(message)),
  transports: [new BufferedFileTransport({ filename: ${JSON.stringify(file)}, maxsize: 10_000_000, maxFiles: 5 })],
});
for (let i = 0; i <= 20000; i++) logger.info("line " + i);
${ending}
`,
      );

      const result = spawnSync(process.execPath, ["--import", "tsx", script], {
        cwd: cliDir,
        encoding: "utf-8",
      });

      expect(result.status, result.stderr).toBe(exitCode);
      const lines = read("cn.log").trimEnd().split("\n");
      expect(lines).toHaveLength(20001);
      expect(lines.at(-1)).toBe("line 20000");
    }, 30000);
  });
});
