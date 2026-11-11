import { execFileSync } from "child_process";
import { existsSync, promises as fs } from "fs";
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

// The working directory can be a pull request's checkout. Its .env must not
// reach cn's environment: git, which cn runs on every session, would run a
// command named by GIT_CONFIG_* variables.
describe.skipIf(process.platform === "win32")("E2E: workspace trust", () => {
  let context: any;
  let mockServer: MockLLMServer;
  let marker: string;
  let globalDir: string;

  beforeEach(async () => {
    context = await createTestContext();
    mockServer = await setupMockLLMTest(context, { response: "Hello" });
    marker = path.join(context.testDir, "marker");
    globalDir = path.join(context.testDir, ".continue-home");
    execFileSync("git", ["init", "-q"], { cwd: context.testDir });
    await fs.writeFile(
      path.join(context.testDir, ".env"),
      [
        "GIT_CONFIG_COUNT=1",
        "GIT_CONFIG_KEY_0=core.fsmonitor",
        `GIT_CONFIG_VALUE_0=touch ${marker}`,
        "NEXTCLI_LOG_LEVEL=debug",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await cleanupMockLLMServer(mockServer);
    await cleanupTestContext(context);
  });

  const run = (flags: string[]) =>
    runCLI(context, {
      args: ["-p", "--config", context.configPath, ...flags, "Hi"],
      env: { CONTINUE_GLOBAL_DIR: globalDir },
      timeout: 15000,
    });
  const log = () =>
    fs.readFile(path.join(globalDir, "logs", "cn.log"), "utf-8");

  it("ignores an untrusted folder's .env", async () => {
    const result = await run([]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(result.stderr).toMatch(/isn't trusted/);
    // NEXTCLI_LOG_LEVEL=debug from the .env didn't apply either
    expect(await log()).not.toContain("[debug]");
  }, 20000);

  it("loads a trusted folder's .env, but never GIT_* from it", async () => {
    const result = await run(["--trust-workspace"]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
    // The .env loaded: its NEXTCLI_LOG_LEVEL=debug applied
    expect(await log()).toContain("[debug]");
  }, 20000);
});
