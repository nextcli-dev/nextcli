import fs from "fs";
import os from "os";
import path from "path";

import { backgroundJobService } from "../services/BackgroundJobService.js";
import { signalAllProcessTrees } from "../util/processTree.js";

import { setRunSafetyOptions } from "./runSafetyOptions.js";
import {
  runCommandInBackground,
  runTerminalCommandTool,
} from "./runTerminalCommand.js";

describe("runTerminalCommandTool", () => {
  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const isLinux = process.platform === "linux";

  describe("basic platform-specific terminal execution", () => {
    it("should execute a simple echo command", async () => {
      let command: string;
      let expectedOutput: string;

      if (isWindows) {
        command = 'Write-Output "hello world"';
        expectedOutput = "hello world";
      } else {
        command = 'echo "hello world"';
        expectedOutput = "hello world";
      }

      const result = await runTerminalCommandTool.run({ command });
      expect(result.trim()).toBe(expectedOutput);
    });

    it("should get current directory", async () => {
      let command: string;

      if (isWindows) {
        command = "Get-Location | Select-Object -ExpandProperty Path";
      } else {
        command = "pwd";
      }

      const result = await runTerminalCommandTool.run({ command });

      if (isWindows) {
        // Windows paths like C:\path\to\dir
        expect(result.trim()).toMatch(/^[A-Za-z]:\\.*/);
      } else {
        // Unix paths like /path/to/dir
        expect(result.trim()).toMatch(/^\/.*$/);
      }
    });

    it("should list directory contents", async () => {
      let command: string;

      if (isWindows) {
        command = "Get-ChildItem | Select-Object -ExpandProperty Name";
      } else {
        command = "ls";
      }

      const result = await runTerminalCommandTool.run({ command });
      // Should return some directory content (not empty)
      expect(result.length).toBeGreaterThan(0);
    });

    it("should handle command that produces version info", async () => {
      // Node.js should be available on all platforms in CI
      const command = "node --version";
      const result = await runTerminalCommandTool.run({ command });

      // Should contain version number (starts with v)
      expect(result.trim()).toMatch(/^v\d+\.\d+\.\d+/);
    });
  });

  describe("basic error handling", () => {
    it("should handle non-existent commands", async () => {
      const command = "definitely-not-a-real-command-xyz123";

      await expect(runTerminalCommandTool.run({ command })).rejects.toMatch(
        /Error \(exit code|Command timed out|not found|not recognized/,
      );
    });
  });

  describe("platform-specific features", () => {
    if (isWindows) {
      it("should work with Windows commands", async () => {
        const result = await runTerminalCommandTool.run({
          command: "Write-Output $env:OS",
        });
        expect(result.trim()).toBe("Windows_NT");
      });
    }

    if (isMac) {
      it("should work with macOS commands", async () => {
        const result = await runTerminalCommandTool.run({
          command: "uname -s",
        });
        expect(result.trim()).toBe("Darwin");
      });
    }

    if (isLinux) {
      it("should work with Linux commands", async () => {
        const result = await runTerminalCommandTool.run({
          command: "uname -s",
        });
        expect(result.trim()).toBe("Linux");
      });
    }
  });
});

// #12700: a command that prints a lot must not flood the context or memory
describe("runTerminalCommandTool output limits", () => {
  const isWindows = process.platform === "win32";

  beforeEach(() => {
    process.env.CONTINUE_CLI_BASH_MAX_OUTPUT_CHARS = "2000";
  });

  afterEach(() => {
    delete process.env.CONTINUE_CLI_BASH_MAX_OUTPUT_CHARS;
  });

  it.skipIf(isWindows)("truncates long stdout to the limit", async () => {
    const result = await runTerminalCommandTool.run({
      command: "yes line | head -n 50000",
    });
    expect(result.length).toBeLessThan(2500);
    expect(result).toContain("truncated");
  });

  it.skipIf(isWindows)(
    "truncates stderr in the error of a failing command",
    async () => {
      let error: unknown;
      try {
        await runTerminalCommandTool.run({
          command: "yes oops | head -n 50000 1>&2; exit 3",
        });
      } catch (e) {
        error = e;
      }
      expect(typeof error).toBe("string");
      expect(String(error).startsWith("Error (exit code 3):")).toBe(true);
      expect(String(error).length).toBeLessThan(2500);
    },
  );
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && isAlive(pid); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

// #12699: a backgrounded child must not block the tool call, and must not
// outlive a timeout or the CLI itself
describe.skipIf(process.platform === "win32")(
  "runTerminalCommandTool background children",
  () => {
    it("returns promptly when the command backgrounds a child", async () => {
      const start = Date.now();
      const result = await runTerminalCommandTool.run({
        command: "sleep 30 & echo $!; echo started",
      });
      const backgroundPid = Number(result.trim().split("\n")[0]);

      expect(Date.now() - start).toBeLessThan(2000);
      expect(result).toContain("started");
      expect(isAlive(backgroundPid)).toBe(true);

      signalAllProcessTrees("SIGKILL");
      expect(await waitUntilDead(backgroundPid)).toBe(true);
    });

    // PR #7 review: closing the pipes killed writers with SIGPIPE
    it("keeps a backgrounded child that writes to stdout alive", async () => {
      const result = await runTerminalCommandTool.run({
        command: `node -e "setInterval(() => console.log('tick'), 50)" & echo $!`,
      });
      const backgroundPid = Number(result.trim().split("\n")[0]);

      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(isAlive(backgroundPid)).toBe(true);

      signalAllProcessTrees("SIGKILL");
      expect(await waitUntilDead(backgroundPid)).toBe(true);
    });

    it("kills backgrounded children on timeout", async () => {
      const result = await runTerminalCommandTool.run({
        command: "sleep 30 & echo $!; sleep 30",
        timeout: 1,
      });
      const backgroundPid = Number(result.trim().split("\n")[0]);

      expect(result).toContain("[Command timed out");
      expect(await waitUntilDead(backgroundPid)).toBe(true);
    });

    // #12701
    it("kills the command and its children when the turn is aborted", async () => {
      const controller = new AbortController();
      const pending = runTerminalCommandTool.run(
        { command: "sleep 30 & echo $!; sleep 30" },
        {
          toolCallId: "call_1",
          parallelToolCallCount: 1,
          signal: controller.signal,
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();

      const result = await pending;
      const backgroundPid = Number(result.trim().split("\n")[0]);

      expect(result).toContain("[Command interrupted]");
      expect(await waitUntilDead(backgroundPid)).toBe(true);
    });

    it("does not start the command when already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await runTerminalCommandTool.run(
        { command: "echo should-not-run" },
        {
          toolCallId: "call_1",
          parallelToolCallCount: 1,
          signal: controller.signal,
        },
      );

      expect(result).toContain("[Command interrupted]");
      expect(result).not.toContain("should-not-run");
    });

    it("kills backgrounded children with SIGTERM on exit", async () => {
      const result = await runTerminalCommandTool.run({
        command: "sleep 30 & echo $!",
      });
      const backgroundPid = Number(result.trim());

      signalAllProcessTrees("SIGTERM");
      expect(await waitUntilDead(backgroundPid)).toBe(true);
    });
  },
);

// PR #7 review: on Windows the tree was forgotten once the shell exited, so a
// child it started outlived the CLI
describe.runIf(process.platform === "win32")(
  "runTerminalCommandTool background children on Windows",
  () => {
    it("kills a child of an exited shell on exit", async () => {
      const result = await runTerminalCommandTool.run({
        command:
          "(Start-Process -PassThru -WindowStyle Hidden ping -ArgumentList '-n','60','127.0.0.1').Id",
      });
      const childPid = Number(result.trim().split(/\r?\n/).pop());

      expect(isAlive(childPid)).toBe(true);

      signalAllProcessTrees("SIGKILL");
      expect(await waitUntilDead(childPid)).toBe(true);
    }, 60000);
  },
);

// A prompt injection must not read the provider key or a CI token with `env`
describe.skipIf(process.platform === "win32")(
  "runTerminalCommandTool environment",
  () => {
    beforeEach(() => {
      process.env.TEST_PLAIN = "plain-value";
      process.env.TEST_SECRET_TOKEN = "secret-value";
    });

    afterEach(() => {
      delete process.env.TEST_PLAIN;
      delete process.env.TEST_SECRET_TOKEN;
      setRunSafetyOptions({});
    });

    it("keeps ordinary variables and drops secret-like ones", async () => {
      const result = await runTerminalCommandTool.run({
        command:
          'echo "plain=$TEST_PLAIN secret=${TEST_SECRET_TOKEN:-unset} home=${HOME:+set}"',
      });
      expect(result.trim()).toBe("plain=plain-value secret=unset home=set");
    });

    it("keeps a variable named with --pass-env", async () => {
      setRunSafetyOptions({ passEnv: ["TEST_SECRET_TOKEN"] });
      const result = await runTerminalCommandTool.run({
        command: 'echo "secret=$TEST_SECRET_TOKEN"',
      });
      expect(result.trim()).toBe("secret=secret-value");
    });
  },
);

// A login shell re-reads the profile, which can export keys again; the
// prelude must remove them while the rest of the profile still applies
describe.skipIf(process.platform === "win32")(
  "runTerminalCommandTool shell profile",
  () => {
    const saved = {
      HOME: process.env.HOME,
      SHELL: process.env.SHELL,
      ZDOTDIR: process.env.ZDOTDIR,
    };
    let home: string;
    const profile = (binDir: string) =>
      [
        "export PROFILE_API_KEY=from-profile",
        "export PROFILE_PLAIN=plain",
        `export PATH="${binDir}:$PATH"`,
      ].join("\n") + "\n";
    const command =
      'echo "key=${PROFILE_API_KEY:-unset} plain=${PROFILE_PLAIN:-unset} path=$(command -v profile-tool)"';

    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), "cn-profile-"));
      const binDir = path.join(home, "bin");
      fs.mkdirSync(binDir);
      fs.writeFileSync(path.join(binDir, "profile-tool"), "#!/bin/sh\n", {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(home, ".bash_profile"), profile(binDir));
      fs.writeFileSync(path.join(home, ".zprofile"), profile(binDir));
      process.env.HOME = home;
      process.env.ZDOTDIR = home;
    });

    afterEach(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      setRunSafetyOptions({});
      fs.rmSync(home, { recursive: true, force: true });
    });

    const shells = ["/bin/bash", "/bin/zsh"].filter((shell) =>
      fs.existsSync(shell),
    );

    describe.each(shells)("%s", (shell) => {
      beforeEach(() => {
        process.env.SHELL = shell;
      });

      it("removes a key the profile exports and keeps the rest", async () => {
        const result = await runTerminalCommandTool.run({ command });
        expect(result.trim()).toBe(
          `key=unset plain=plain path=${path.join(home, "bin", "profile-tool")}`,
        );
      });

      it("keeps a profile key named with --pass-env", async () => {
        setRunSafetyOptions({ passEnv: ["PROFILE_API_KEY"] });
        const result = await runTerminalCommandTool.run({
          command: 'echo "key=$PROFILE_API_KEY"',
        });
        expect(result.trim()).toBe("key=from-profile");
      });

      it("removes it from background jobs too", async () => {
        const started = runCommandInBackground(command);
        expect(started.success).toBe(true);
        let job = backgroundJobService.getJob(started.jobId!)!;
        for (let i = 0; i < 50 && job.status === "running"; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          job = backgroundJobService.getJob(started.jobId!)!;
        }
        expect(job.output.trim()).toBe(
          `key=unset plain=plain path=${path.join(home, "bin", "profile-tool")}`,
        );
      });
    });

    it("falls back to a POSIX shell for a non-POSIX $SHELL", async () => {
      process.env.SHELL = "/usr/local/bin/fish";
      const result = await runTerminalCommandTool.run({ command });
      expect(result.trim()).toBe(
        `key=unset plain=plain path=${path.join(home, "bin", "profile-tool")}`,
      );
    });
  },
);
