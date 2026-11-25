import { describe, expect, it } from "vitest";

import { startMockServer } from "./mock-server.mjs";
import { exec } from "./proc.mjs";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("exec", () => {
  it.skipIf(process.platform === "win32")(
    "stops a timed-out command and the detached commands it started",
    async () => {
      // As cn runs Bash: a detached child in its own process group
      const script = `
        const { spawn } = require("node:child_process");
        const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
        console.log(child.pid);
        setInterval(() => {}, 1000);
      `;
      const result = await exec(process.execPath, ["-e", script], {
        timeoutMs: 1500,
      });

      expect(result.timedOut).toBe(true);
      const sleeper = Number(result.stdout.trim());
      expect(sleeper).toBeGreaterThan(0);
      await expect.poll(() => alive(sleeper)).toBe(false);
    },
  );
});

describe("the mock model", () => {
  const ask = async (url) => {
    const response = await fetch(`${url}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "go" }] }),
    });
    return response.text();
  };

  it("starts its script over for each run", async () => {
    const mock = await startMockServer();
    try {
      for (let i = 0; i < 5; i++) await ask(mock.url);
      expect(await ask(mock.url)).toContain("Finished reading the logs.");

      mock.reset();

      expect(await ask(mock.url)).toContain("logs/app-1.log");
    } finally {
      await mock.close();
    }
  });
});
