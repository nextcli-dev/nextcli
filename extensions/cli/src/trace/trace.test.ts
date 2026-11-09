import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());

vi.mock("../session.js", () => ({
  getCurrentSession: () => ({ sessionId: "s1" }),
}));
vi.mock("../util/logger.js", () => ({
  logger: { warn, getRunId: () => "r1" },
}));

describe("traceEvent", () => {
  let root: string;
  let dir: string;

  async function loadTrace(level?: string) {
    vi.resetModules();
    if (level === undefined) {
      delete process.env.NEXTCLI_TRACE;
    } else {
      process.env.NEXTCLI_TRACE = level;
    }
    process.env.NEXTCLI_TRACE_DIR = dir;
    return (await import("./trace.js")).traceEvent;
  }

  function readLines(): any[] {
    return fs
      .readFileSync(path.join(dir, "s1-r1.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cn-trace-"));
    dir = path.join(root, "traces");
    warn.mockClear();
  });

  afterEach(() => {
    delete process.env.NEXTCLI_TRACE;
    delete process.env.NEXTCLI_TRACE_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes nothing when NEXTCLI_TRACE is unset", async () => {
    const traceEvent = await loadTrace();

    traceEvent("llm.request", { model: "m" }, { ts: 1000, dur: 50 });

    expect(fs.existsSync(dir)).toBe(false);
  });

  it("writes a header, then one line per event", async () => {
    const traceEvent = await loadTrace("basic");

    traceEvent("llm.request", { model: "m" }, { ts: 1000, dur: 50 });
    traceEvent("llm.request", { model: "m", discarded: true }, { ts: 2000 });

    const [header, ...events] = readLines();
    expect(header).toMatchObject({
      name: "header",
      attrs: { runId: "r1", sessionId: "s1", node: process.version },
    });
    expect(events).toEqual([
      { ts: 1000, dur: 50, name: "llm.request", attrs: { model: "m" } },
      {
        ts: 2000,
        name: "llm.request",
        attrs: { model: "m", discarded: true },
      },
    ]);
  });

  it("warns once and stays off for an unknown NEXTCLI_TRACE", async () => {
    const traceEvent = await loadTrace("full");

    traceEvent("llm.request", { model: "m" }, { ts: 1000 });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('NEXTCLI_TRACE "full"');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("stops after the first write that fails", async () => {
    // A file where the trace folder should be
    fs.writeFileSync(dir, "");
    const traceEvent = await loadTrace("basic");

    traceEvent("llm.request", { model: "m" }, { ts: 1000 });
    traceEvent("llm.request", { model: "m" }, { ts: 2000 });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(fs.statSync(dir).isFile()).toBe(true);
  });
});
