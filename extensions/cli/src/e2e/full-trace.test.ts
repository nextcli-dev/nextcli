import { promises as fs } from "fs";
import * as http from "http";
import path from "path";

import {
  cleanupTestContext,
  createTestContext,
  runCLI,
} from "../test-helpers/cli-helpers.js";
import {
  cleanupMockLLMServer,
  setupMockLLMTest,
  type MockLLMServer,
} from "../test-helpers/mock-llm-server.js";

describe("E2E: NEXTCLI_TRACE=full request files", () => {
  let context: any;
  let mockServer: MockLLMServer;

  beforeEach(async () => {
    context = await createTestContext();
  });

  afterEach(async () => {
    if (mockServer) {
      await cleanupMockLLMServer(mockServer);
    }
    await cleanupTestContext(context);
  });

  async function runWithTrace(level: string, traceDir: string) {
    mockServer = await setupMockLLMTest(context, {
      customHandler: (req: http.IncomingMessage, res: http.ServerResponse) => {
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, index: 0 }] })}\n\n`,
          );
          res.write(
            `data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n`,
          );
          res.write(`data: [DONE]\n\n`);
          res.end();
        });
      },
    });

    return runCLI(context, {
      args: ["-p", "--config", context.configPath, "Say ok"],
      timeout: 30000,
      env: { NEXTCLI_TRACE: level, NEXTCLI_TRACE_DIR: traceDir },
    });
  }

  it("full writes each provider request next to the trace", async () => {
    const traceDir = path.join(context.testDir, "traces");

    const result = await runWithTrace("full", traceDir);

    expect(result.exitCode).toBe(0);
    const entries = await fs.readdir(traceDir);
    const jsonl = entries.find((e) => e.endsWith(".jsonl"))!;
    const requestDir = entries.find((e) => !e.endsWith(".jsonl"))!;
    expect(jsonl).toBeDefined();
    expect(requestDir).toBeDefined();
    // Same run: <sessionId>-<runId>.jsonl and <sessionId>-<runId>/
    expect(requestDir).toBe(jsonl.replace(/\.jsonl$/, ""));

    const files = await fs.readdir(path.join(traceDir, requestDir));
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files).toContain("request-1.json");
    const request = JSON.parse(
      await fs.readFile(
        path.join(traceDir, requestDir, "request-1.json"),
        "utf-8",
      ),
    );
    // The body as the provider received it
    expect(request.method).toBe("POST");
    expect(request.url).toContain("/chat/completions");
    expect(request.body.model).toBeDefined();
    expect(
      request.body.messages.some((m: any) =>
        JSON.stringify(m).includes("Say ok"),
      ),
    ).toBe(true);
  });

  it("basic writes no request files", async () => {
    const traceDir = path.join(context.testDir, "traces");

    const result = await runWithTrace("basic", traceDir);

    expect(result.exitCode).toBe(0);
    const entries = await fs.readdir(traceDir);
    expect(entries.every((e) => e.endsWith(".jsonl"))).toBe(true);
  });
});
