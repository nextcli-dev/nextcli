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

// #12702 / #12626: a model that asks for the same tool call forever, reusing the
// same tool call id, must not keep the CLI running
describe("E2E: agent loop limits", () => {
  let context: any;
  let mockServer: MockLLMServer;
  let requestCount: number;
  let requestBodies: any[];

  beforeEach(async () => {
    context = await createTestContext();
    requestCount = 0;
    requestBodies = [];
  });

  afterEach(async () => {
    if (mockServer) {
      await cleanupMockLLMServer(mockServer);
    }
    await cleanupTestContext(context);
  });

  // The last allowed call is a wrap-up without tools. The mock keeps asking for
  // the tool anyway, so this also checks that those tool calls are dropped.
  it("stops a model that repeats the same tool call forever", async () => {
    mockServer = await setupMockLLMTest(context, {
      customHandler: (req: http.IncomingMessage, res: http.ServerResponse) => {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          if (req.method !== "POST" || req.url !== "/chat/completions") {
            res.writeHead(404);
            res.end("Not found");
            return;
          }
          requestCount++;
          requestBodies.push(JSON.parse(body));
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(
            `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_same","type":"function","function":{"name":"List","arguments":"{\\"dirpath\\":\\".\\"}"}}]},"index":0}]}\n\n`,
          );
          res.write(
            `data: {"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n`,
          );
          res.write(`data: [DONE]\n\n`);
          res.end();
        });
      },
    });

    const result = await runCLI(context, {
      args: [
        "-p",
        "--auto",
        "--max-turns",
        "5",
        "--format",
        "json",
        "--config",
        context.configPath,
        "List the files",
      ],
      timeout: 30000,
      expectError: true,
    });

    expect(requestCount).toBe(5);
    expect(requestBodies[3].tools?.length).toBeGreaterThan(0);
    expect(requestBodies[4].tools ?? []).toHaveLength(0);
    expect(result.exitCode).toBe(3);
    const summary = JSON.parse(result.stderr.trim().split("\n").pop()!);
    expect(summary).toMatchObject({ status: "limit", limit: "turns" });
  }, 40000);
});
