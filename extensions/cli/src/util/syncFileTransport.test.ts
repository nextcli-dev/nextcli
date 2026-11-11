import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import winston from "winston";

import { SyncFileTransport } from "./syncFileTransport.js";

describe("SyncFileTransport", () => {
  let dir: string;
  let file: string;
  let transport: SyncFileTransport | undefined;

  const loggerWith = (options: { maxsize: number; maxFiles: number }) => {
    transport = new SyncFileTransport({ filename: file, ...options });
    return winston.createLogger({
      format: winston.format.printf(({ message }) => String(message)),
      transports: [transport],
    });
  };
  const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf-8");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-log-"));
    file = path.join(dir, "cn.log");
  });

  afterEach(() => {
    transport?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // process.exit() can follow any log call, so nothing may wait in a buffer
  it("has every line on disk when the log call returns", () => {
    const logger = loggerWith({ maxsize: 10_000_000, maxFiles: 5 });

    for (let i = 0; i < 5000; i++) logger.info(`line ${i}`);

    const lines = read("cn.log").trimEnd().split("\n");
    expect(lines).toHaveLength(5000);
    expect(lines.at(-1)).toBe("line 4999");
  });

  it("appends to an existing log", () => {
    fs.writeFileSync(file, "earlier run\n");
    loggerWith({ maxsize: 10_000_000, maxFiles: 5 }).info("this run");

    expect(read("cn.log")).toBe("earlier run\nthis run\n");
  });

  it("rotates at the size limit and keeps maxFiles files", () => {
    const logger = loggerWith({ maxsize: 20, maxFiles: 3 });

    // Each line is 10 bytes, so every file holds two
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) logger.info(`line ${n}...`);

    expect(read("cn.log")).toBe("line 7...\nline 8...\n");
    expect(read("cn1.log")).toBe("line 5...\nline 6...\n");
    expect(read("cn2.log")).toBe("line 3...\nline 4...\n");
    expect(fs.existsSync(path.join(dir, "cn3.log"))).toBe(false);
  });

  it("doesn't throw when the file can't be written", () => {
    file = path.join(dir, "missing-dir", "cn.log");
    const logger = loggerWith({ maxsize: 10_000_000, maxFiles: 5 });

    expect(() => logger.info("lost")).not.toThrow();
  });
});
