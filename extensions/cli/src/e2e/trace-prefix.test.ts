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

// A5: the trace says which request kept the cached prefix, and the JSON
// summary says how much of the run's prompt was read from the cache
describe("E2E: cache prefix on the trace", () => {
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

  it("marks tool rounds as extending the prefix and the tool-free last call as not", async () => {
    let requestCount = 0;
    mockServer = await setupMockLLMTest(context, {
      customHandler: (req: http.IncomingMessage, res: http.ServerResponse) => {
        req.on("data", () => {});
        req.on("end", () => {
          requestCount++;
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_${requestCount}`,
                        type: "function",
                        function: {
                          name: "List",
                          arguments: JSON.stringify({ dirpath: "." }),
                        },
                      },
                    ],
                  },
                },
              ],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              usage: {
                prompt_tokens: 100,
                completion_tokens: 5,
                prompt_tokens_details: { cached_tokens: 60 },
              },
            })}\n\n`,
          );
          res.write(`data: [DONE]\n\n`);
          res.end();
        });
      },
    });
    const traceDir = path.join(context.testDir, "traces");

    const result = await runCLI(context, {
      args: [
        "-p",
        "--auto",
        "--max-turns",
        "3",
        "--format",
        "json",
        "--config",
        context.configPath,
        "List the files",
      ],
      timeout: 30000,
      expectError: true,
      env: { NEXTCLI_TRACE: "basic", NEXTCLI_TRACE_DIR: traceDir },
    });

    expect(result.exitCode).toBe(3);
    const [file] = (await fs.readdir(traceDir)).filter((name) =>
      name.endsWith(".jsonl"),
    );
    const requests = (await fs.readFile(path.join(traceDir, file!), "utf-8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.name === "llm.request");
    const prefixes = requests.map((event) => event.attrs.prefix);
    expect(prefixes).toHaveLength(3);

    // The first request has nothing to extend
    expect(prefixes[0].extendsPrevious).toBeUndefined();
    // A tool round sends the same system message, tools and history, plus more
    expect(prefixes[1]).toMatchObject({
      systemHash: prefixes[0].systemHash,
      toolsHash: prefixes[0].toolsHash,
      extendsPrevious: true,
    });
    expect(prefixes[1].changed).toBeUndefined();
    // The last call at --max-turns sends no tools
    expect(prefixes[2]).toMatchObject({
      systemHash: prefixes[0].systemHash,
      extendsPrevious: false,
      changed: "tools",
    });

    const summary = JSON.parse(result.stderr.trim().split("\n").pop()!);
    expect(summary.usage).toMatchObject({
      promptTokens: 300,
      cachedTokens: 180,
      cacheWriteTokens: 0,
    });
  }, 40000);
});
