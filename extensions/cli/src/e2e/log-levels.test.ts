import { promises as fs } from "fs";
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

describe("E2E: log levels", () => {
  let context: any;
  let mockServer: MockLLMServer;

  beforeEach(async () => {
    context = await createTestContext();
    mockServer = await setupMockLLMTest(context, { response: "Hello" });
  });

  afterEach(async () => {
    await cleanupMockLLMServer(mockServer);
    await cleanupTestContext(context);
  });

  async function runAndReadLog(flags: string[], env: Record<string, string>) {
    const globalDir = path.join(context.testDir, ".continue");
    const result = await runCLI(context, {
      args: ["-p", "--config", context.configPath, ...flags, "Hi"],
      env: { CONTINUE_GLOBAL_DIR: globalDir, ...env },
      timeout: 15000,
    });
    expect(result.exitCode).toBe(0);
    return fs.readFile(path.join(globalDir, "logs", "cn.log"), "utf-8");
  }

  it("--verbose logs debug lines without the model's API key", async () => {
    const log = await runAndReadLog(["--verbose"], {});

    expect(log).toContain("[debug]");
    expect(log).not.toContain("[trace]");
    // The mock config's apiKey
    expect(log).not.toContain("test-key");
  }, 20000);

  it("--log-level verbose logs each model call without debug lines", async () => {
    const log = await runAndReadLog(["--log-level", "verbose"], {});

    expect(log).toContain("[verbose]: Model call");
    expect(log).not.toContain("[debug]");
  }, 20000);

  it("NEXTCLI_LOG_LEVEL=trace logs each stream chunk", async () => {
    const log = await runAndReadLog([], { NEXTCLI_LOG_LEVEL: "trace" });

    expect(log).toContain("Received chunk");
  }, 20000);

  it("accepts --log-level after a subcommand", async () => {
    const result = await runCLI(context, {
      args: ["review", "--log-level", "verbose", "--help"],
    });

    expect(result.exitCode).toBe(0);
  });

  it("--log-level wins over NEXTCLI_LOG_LEVEL", async () => {
    const log = await runAndReadLog(["--log-level", "info"], {
      NEXTCLI_LOG_LEVEL: "trace",
    });

    expect(log).not.toContain("Received chunk");
  }, 20000);
});
