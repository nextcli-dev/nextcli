import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());

vi.mock("../session.js", () => ({
  getCurrentSession: () => ({ sessionId: "s1" }),
}));
const warnBadEnv = vi.hoisted(() => vi.fn());

vi.mock("../util/logger.js", () => ({
  logger: { warn, getRunId: () => "r1" },
  warnBadEnv,
}));

// NEXTCLI_TRACE=full: the same llm.request lines as basic, plus one JSON
// file per request under <traceDir>/<sessionId>-<runId>/, with secrets
// redacted. Off and basic compute nothing.
describe("traceRequest (full mode)", () => {
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
    return await import("./trace.js");
  }

  const requestDir = () => path.join(dir, "s1-r1");

  const payload = () => ({
    model: "m",
    messages: [{ role: "user", content: "Review this PR text" }],
    tools: [{ type: "function", function: { name: "Read" } }],
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cn-trace-full-"));
    dir = path.join(root, "traces");
    warn.mockClear();
    warnBadEnv.mockClear();
  });

  afterEach(() => {
    delete process.env.NEXTCLI_TRACE;
    delete process.env.NEXTCLI_TRACE_DIR;
    delete process.env.MY_API_KEY;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes nothing when unset", async () => {
    const { traceRequest } = await loadTrace();

    traceRequest(payload());

    expect(fs.existsSync(dir)).toBe(false);
  });

  it("writes nothing for basic", async () => {
    const { traceRequest } = await loadTrace("basic");

    traceRequest(payload());

    expect(fs.existsSync(requestDir())).toBe(false);
  });

  it("writes one numbered file per request for full", async () => {
    const { traceRequest } = await loadTrace("full");

    traceRequest(payload());
    traceRequest({ ...payload(), attempt: 2 });

    const files = fs.readdirSync(requestDir()).sort();
    expect(files).toEqual(["request-1.json", "request-2.json"]);
    const first = JSON.parse(
      fs.readFileSync(path.join(requestDir(), files[0]), "utf-8"),
    );
    expect(first.messages[0].content).toBe("Review this PR text");
    expect(first.tools[0].function.name).toBe("Read");
    const second = JSON.parse(
      fs.readFileSync(path.join(requestDir(), files[1]), "utf-8"),
    );
    expect(second.attempt).toBe(2);
  });

  it("redacts secret-like env values wherever they appear", async () => {
    process.env.MY_API_KEY = "sk-env-secret-0123456789";
    const { traceRequest } = await loadTrace("full");

    traceRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: "the key is sk-env-secret-0123456789, keep it safe",
        },
      ],
    });

    const written = fs.readFileSync(
      path.join(requestDir(), "request-1.json"),
      "utf-8",
    );
    expect(written).not.toContain("sk-env-secret-0123456789");
    expect(written).toContain("[redacted]");
    expect(written).toContain("keep it safe");
  });

  it("redacts the model's configured apiKey and secret env entries", async () => {
    const { traceRequest } = await loadTrace("full");

    traceRequest({
      model: "m",
      apiKey: "configured-key-abcdef",
      env: { SERVICE_TOKEN: "env-token-abcdef", REGION: "eu" },
      requestOptions: {
        headers: { Authorization: "Bearer configured-key-abcdef" },
      },
      messages: [{ role: "user", content: "configured-key-abcdef" }],
    });

    const written = fs.readFileSync(
      path.join(requestDir(), "request-1.json"),
      "utf-8",
    );
    expect(written).not.toContain("configured-key-abcdef");
    expect(written).not.toContain("env-token-abcdef");
    expect(written).toContain("eu");
  });

  it("does not mutate the payload it is given", async () => {
    process.env.MY_API_KEY = "sk-env-secret-0123456789";
    const { traceRequest } = await loadTrace("full");
    const request = {
      model: "m",
      messages: [
        { role: "user", content: "key sk-env-secret-0123456789 here" },
      ],
    };

    traceRequest(request);

    expect(request.messages[0].content).toBe(
      "key sk-env-secret-0123456789 here",
    );
  });

  it("reads the level at the first request, not at module load", async () => {
    const { traceRequest } = await loadTrace();
    process.env.NEXTCLI_TRACE = "full";

    traceRequest(payload());

    expect(fs.existsSync(path.join(requestDir(), "request-1.json"))).toBe(true);
  });

  it("stops after the first write that fails", async () => {
    // A file where the trace folder should be
    fs.writeFileSync(dir, "");
    const { traceRequest } = await loadTrace("full");

    traceRequest(payload());
    traceRequest(payload());

    expect(warn).toHaveBeenCalledTimes(1);
    expect(fs.statSync(dir).isFile()).toBe(true);
  });
});
