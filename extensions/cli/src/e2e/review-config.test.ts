import { execSync } from "child_process";
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

describe("E2E: cn review --config", () => {
  let context: any;
  let mockServer: MockLLMServer;

  beforeEach(async () => {
    context = await createTestContext();
    mockServer = await setupMockLLMTest(context, { response: "No issues" });

    // A branch with one change and one review agent
    const repo = context.testDir;
    await fs.mkdir(path.join(repo, ".continue", "agents"), { recursive: true });
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: repo });
    git("init -q -b main");
    git("config user.email test@example.com");
    git("config user.name test");
    await fs.writeFile(path.join(repo, "a.txt"), "a\n");
    git("add a.txt");
    git("commit -qm init");
    git("checkout -qb feature");
    await fs.writeFile(path.join(repo, "a.txt"), "a\nb\n");
    await fs.writeFile(
      path.join(repo, ".continue", "agents", "r.md"),
      "---\nname: R\ndescription: test\n---\nReview the change.\n",
    );
    git("add a.txt .continue/agents");
    git("commit -qm change");
  });

  afterEach(async () => {
    await cleanupMockLLMServer(mockServer);
    await cleanupTestContext(context);
  });

  it("gives the review worker the config from the flag", async () => {
    // The test home has no config.yaml, so only the flag can supply one
    const result = await runCLI(context, {
      args: [
        "review",
        "--config",
        context.configPath,
        "--base",
        "main",
        "--format",
        "json",
      ],
      env: { FORCE_NO_TTY: "true" },
      timeout: 60000,
      expectError: true,
    });

    expect(result.stdout + result.stderr).not.toContain("no hosted API");
    expect(mockServer.requests.length).toBeGreaterThan(0);
  }, 70000);
});
