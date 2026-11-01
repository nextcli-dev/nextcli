import {
  isRunningInWsl,
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

  describe("WSL detection", () => {
    it("should cache the WSL detection result", () => {
      const firstResult = isRunningInWsl();
      const secondResult = isRunningInWsl();
      expect(firstResult).toBe(secondResult);
    });

    if (!isLinux) {
      it("should return false on non-Linux platforms", () => {
        expect(isRunningInWsl()).toBe(false);
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
