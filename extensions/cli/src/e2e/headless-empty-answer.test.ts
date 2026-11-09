import * as http from "http";

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

// A model whose last turn is empty must not end a headless run with exit 0
// and nothing on stdout: a script reading the answer would get nothing.
describe("E2E: empty final answer in headless mode", () => {
  let context: any;
  let mockServer: MockLLMServer;
  let requestCount: number;

  beforeEach(async () => {
    context = await createTestContext();
    requestCount = 0;
  });

  afterEach(async () => {
    if (mockServer) {
      await cleanupMockLLMServer(mockServer);
    }
    await cleanupTestContext(context);
  });

  // Replies with the given texts in order, then empty replies.
  async function serve(replies: string[]) {
    mockServer = await setupMockLLMTest(context, {
      customHandler: (req: http.IncomingMessage, res: http.ServerResponse) => {
        req.on("data", () => {});
        req.on("end", () => {
          if (req.method !== "POST" || req.url !== "/chat/completions") {
            res.writeHead(404);
            res.end("Not found");
            return;
          }
          const reply = replies[requestCount++] ?? "";
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          if (reply) {
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: { content: reply }, index: 0 }] })}\n\n`,
            );
          }
          res.write(
            `data: {"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n`,
          );
          res.write(`data: [DONE]\n\n`);
          res.end();
        });
      },
    });
  }

  const args = (context: any) => [
    "-p",
    "--format",
    "json",
    "--config",
    context.configPath,
    "Review this",
  ];

  it("asks for the answer once and prints it", async () => {
    await serve(["", '{"verdict":"PASS"}']);

    const result = await runCLI(context, {
      args: args(context),
      timeout: 30000,
    });

    expect(requestCount).toBe(2);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ verdict: "PASS" });
    const summary = JSON.parse(result.stderr.trim().split("\n").pop()!);
    expect(summary).toMatchObject({ status: "done" });
  }, 40000);

  it("fails with an error line and usage when the answer stays empty", async () => {
    await serve([]);

    const result = await runCLI(context, {
      args: args(context),
      timeout: 30000,
      expectError: true,
    });

    expect(requestCount).toBe(2);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.trim()).toBe("");
    const line = JSON.parse(result.stderr.trim().split("\n").pop()!);
    expect(line).toMatchObject({
      status: "error",
      message: "The model finished without writing an answer.",
      usage: { promptTokens: 20, completionTokens: 40 },
    });
  }, 40000);

  it("names the output cap when the model was cut off before answering", async () => {
    mockServer = await setupMockLLMTest(context, {
      customHandler: (req: http.IncomingMessage, res: http.ServerResponse) => {
        req.on("data", () => {});
        req.on("end", () => {
          requestCount++;
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(
            `data: {"choices":[{"delta":{},"finish_reason":"length","index":0}]}\n\n`,
          );
          res.write(
            `data: {"usage":{"prompt_tokens":10,"completion_tokens":4096}}\n\n`,
          );
          res.write(`data: [DONE]\n\n`);
          res.end();
        });
      },
    });

    const result = await runCLI(context, {
      args: args(context),
      timeout: 30000,
      expectError: true,
    });

    expect(result.exitCode).toBe(1);
    const line = JSON.parse(result.stderr.trim().split("\n").pop()!);
    expect(line.message).toContain(
      "The model used all its output tokens (4096) before writing an answer.",
    );
  }, 40000);

  // Plain -p may end silently, for example after a run that only edits files
  it("leaves an empty answer alone without --format json", async () => {
    await serve([]);

    const result = await runCLI(context, {
      args: ["-p", "--config", context.configPath, "Review this"],
      timeout: 30000,
    });

    expect(requestCount).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  }, 40000);
});
