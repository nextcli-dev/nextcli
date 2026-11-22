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

describe("E2E: context snapshot in the trace", () => {
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

  it("names the agent file and a project rule", async () => {
    await fs.writeFile(
      path.join(context.testDir, "AGENTS.md"),
      "Follow the project notes.",
    );
    const rulesDir = path.join(context.testDir, ".continue", "rules");
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.writeFile(
      path.join(rulesDir, "house.md"),
      "---\nname: house style\n---\nBe brief.\n",
    );
    const traceDir = path.join(context.testDir, "traces");

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

    const result = await runCLI(context, {
      args: ["-p", "--config", context.configPath, "Say ok"],
      timeout: 30000,
      env: {
        NEXTCLI_TRACE: "basic",
        NEXTCLI_TRACE_DIR: traceDir,
      },
    });

    expect(result.exitCode).toBe(0);
    const files = await fs.readdir(traceDir);
    const trace = await fs.readFile(path.join(traceDir, files[0]), "utf-8");
    expect(trace).toContain("AGENTS.md");
    expect(trace).toContain("house style");
    expect(trace).toContain('"used"');
  });
});
