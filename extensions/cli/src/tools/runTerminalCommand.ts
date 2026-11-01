import { ChildProcess, spawn } from "child_process";
import fs from "fs";

import {
  evaluateTerminalCommandSecurity,
  type ToolPolicy,
} from "@continuedev/terminal-security";

import { backgroundJobService } from "../services/BackgroundJobService.js";
import { services } from "../services/index.js";
import { telemetryService } from "../telemetry/telemetryService.js";
import {
  isGitCommitCommand,
  isPullRequestCommand,
} from "../telemetry/utils.js";
import { backgroundSignalManager } from "../util/backgroundSignalManager.js";
import { emitBashToolEnded, emitBashToolStarted } from "../util/cli.js";
import {
  killProcessTree,
  processTreeSpawnOptions,
  trackProcessTree,
} from "../util/processTree.js";
import {
  parseEnvNumber,
  truncateOutputFromStart,
} from "../util/truncateOutput.js";

import { Tool, ToolRunContext } from "./types.js";

// Output truncation defaults
const DEFAULT_BASH_MAX_CHARS = 50000; // ~12.5k tokens
const DEFAULT_BASH_MAX_LINES = 1000;
// Only the tail of the output is ever returned, so the in-memory buffers keep a
// bounded tail too (a command that prints gigabytes must not exhaust memory)
const BUFFER_TAIL_FACTOR = 4;
// How long to keep reading output after the shell exits. A backgrounded child
// (`cmd &`) inherits stdout/stderr, so waiting for them to close would block
// until that child exits.
const OUTPUT_DRAIN_MS = 300;

function appendToTail(
  buffer: string,
  chunk: string,
  maxLength: number,
): string {
  const combined = buffer + chunk;
  return combined.length > maxLength
    ? combined.slice(combined.length - maxLength)
    : combined;
}

/**
 * When running on Windows, but inside WSL, shell commands need to run using the WSL environment.
 */
export function isRunningInWsl(): boolean {
  // WSL only applies when platform reports as Linux
  if (process.platform !== "linux") {
    return false;
  }

  if (process.env.WSL_DISTRO_NAME) {
    return true;
  }

  // Check /proc/version for Microsoft/WSL indicators
  try {
    const procVersion = fs.readFileSync("/proc/version", "utf8").toLowerCase();
    return procVersion.includes("microsoft") || procVersion.includes("wsl");
  } catch {
    return false;
  }
}

function getBashMaxChars(): number {
  return parseEnvNumber(
    process.env.CONTINUE_CLI_BASH_MAX_OUTPUT_CHARS,
    DEFAULT_BASH_MAX_CHARS,
  );
}

function getBashMaxLines(): number {
  return parseEnvNumber(
    process.env.CONTINUE_CLI_BASH_MAX_OUTPUT_LINES,
    DEFAULT_BASH_MAX_LINES,
  );
}

// Helper function to use login shell on Unix/macOS and PowerShell on Windows and available shell in WSL
function getShellCommand(command: string): { shell: string; args: string[] } {
  if (process.platform === "win32") {
    // Windows: Use PowerShell
    return {
      shell: "powershell.exe",
      args: ["-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", command],
    };
  }

  if (isRunningInWsl()) {
    // in WSL, bash is always available
    const wslShell = process.env.SHELL || "/bin/bash";
    return {
      shell: wslShell,
      args: ["-l", "-c", command],
    };
  }

  // Unix/macOS: Use login shell to source .bashrc/.zshrc etc.
  const userShell = process.env.SHELL || "/bin/bash";
  return { shell: userShell, args: ["-l", "-c", command] };
}

export function runCommandInBackground(command: string): {
  success: boolean;
  jobId?: string;
  error?: string;
} {
  const job = backgroundJobService.createJob(command);
  if (!job) {
    return {
      success: false,
      error: "Cannot create background job: limit of 5 concurrent jobs reached",
    };
  }

  const { shell, args } = getShellCommand(command);
  const child = backgroundJobService.startJob(job.id, shell, args);

  if (!child) {
    return {
      success: false,
      error: `Failed to start background job ${job.id}`,
    };
  }

  return {
    success: true,
    jobId: job.id,
  };
}

export const runTerminalCommandTool: Tool = {
  name: "Bash",
  displayName: "Bash",
  description: `Executes a terminal command and returns the output

Commands are automatically executed from the current working directory (${process.cwd()}), so there's no need to change directories with 'cd' commands.

IMPORTANT: To edit files, use Edit/MultiEdit tools instead of bash commands (sed, awk, etc).
`,
  parameters: {
    type: "object",
    required: ["command"],
    properties: {
      command: {
        type: "string",
        description: "The command to execute in the terminal.",
      },
      timeout: {
        type: "number",
        description:
          "Optional timeout in seconds (max 600). Use this parameter for commands that take longer than the default 180 second timeout.",
      },
    },
  },
  readonly: false,
  isBuiltIn: true,
  evaluateToolCallPolicy: (
    basePolicy: ToolPolicy,
    parsedArgs: Record<string, unknown>,
  ): ToolPolicy => {
    return evaluateTerminalCommandSecurity(
      basePolicy,
      parsedArgs.command as string,
    );
  },
  preprocess: async (args) => {
    const command = args.command;
    if (!command || typeof command !== "string") {
      throw new Error("command arg is required and must be a non-empty string");
    }
    const truncatedCmd =
      command.length > 60 ? command.substring(0, 60) + "..." : command;
    return {
      args,
      preview: [
        {
          type: "text",
          content: `Will run: ${truncatedCmd}`,
        },
      ],
    };
  },
  run: async (
    {
      command,
      timeout,
    }: {
      command: string;
      timeout?: number;
    },
    context?: ToolRunContext,
  ): Promise<string> => {
    // Divide limits by parallel tool call count to avoid context overflow
    const parallelCount = context?.parallelToolCallCount ?? 1;
    const baseMaxChars = getBashMaxChars();
    const baseMaxLines = getBashMaxLines();
    const maxChars = Math.floor(baseMaxChars / parallelCount);
    const maxLines = Math.floor(baseMaxLines / parallelCount);

    if (context?.signal?.aborted) {
      return "[Command interrupted]";
    }

    emitBashToolStarted();

    let removeAbortListener = () => {};
    const outputPromise: Promise<string> = new Promise((resolve, reject) => {
      // Use same shell logic as core implementation
      const { shell, args } = getShellCommand(command);
      const child = spawn(shell, args, processTreeSpawnOptions());
      trackProcessTree(child);
      let stdout = "";
      let stderr = "";
      const bufferLimit = Math.max(maxChars, 1) * BUFFER_TAIL_FACTOR;
      const truncate = (output: string) => {
        const result = truncateOutputFromStart(output, {
          maxChars,
          maxLines,
        });
        return result.wasTruncated
          ? appendParallelLimitNote(result.output)
          : result.output;
      };
      let timeoutId: NodeJS.Timeout;
      let isResolved = false;

      // Determine timeout: use provided timeout (capped at 600s), test env variable, or default 120s
      let TIMEOUT_MS = 180000; // 180 seconds default
      if (timeout !== undefined) {
        // Cap at 600 seconds (10 minutes)
        const cappedTimeout = Math.min(timeout, 600);
        TIMEOUT_MS = cappedTimeout * 1000;
      } else if (
        process.env.NODE_ENV === "test" &&
        process.env.TEST_TERMINAL_TIMEOUT
      ) {
        TIMEOUT_MS = parseInt(process.env.TEST_TERMINAL_TIMEOUT, 10);
      }

      /**
       * Appends a note about reduced limits when parallel tool calls are in effect.
       */
      const appendParallelLimitNote = (output: string): string => {
        if (parallelCount > 1) {
          return (
            output +
            `\n\n(Note: output limit reduced due to ${parallelCount} parallel tool calls. ` +
            `Single-tool limit: ${baseMaxChars.toLocaleString()} characters or ${baseMaxLines.toLocaleString()} lines.)`
          );
        }
        return output;
      };

      const moveToBackground = () => {
        if (isResolved) return;
        isResolved = true;

        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        backgroundSignalManager.off("backgroundRequested", moveToBackground);

        // Detach stdout/stderr listeners so they don't accumulate in local
        // buffers or trigger chat history updates after the tool call resolves.
        // BackgroundJobService.createJobWithProcess attaches its own listeners.
        child.stdout.removeListener("data", onStdout);
        child.stderr.removeListener("data", onStderr);

        const job = backgroundJobService.createJobWithProcess(
          command,
          child as ChildProcess,
          stdout,
        );

        if (job) {
          const truncationResult = truncateOutputFromStart(stdout, {
            maxChars,
            maxLines,
          });
          const outputSoFar = truncationResult.wasTruncated
            ? appendParallelLimitNote(truncationResult.output)
            : truncationResult.output;
          resolve(
            `Command moved to background. Job ID: ${job.id}\nOutput so far:\n${outputSoFar}\nUse CheckBackgroundJob("${job.id}") to check status.`,
          );
        } else {
          resolve(
            `Failed to move to background (job limit reached). Command continues in foreground.\nOutput so far: ${truncate(stdout)}`,
          );
        }
      };

      backgroundSignalManager.on("backgroundRequested", moveToBackground);

      // #12701: an interrupted turn must not leave the command running
      const onAbort = () => {
        if (isResolved) return;
        isResolved = true;

        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        backgroundSignalManager.off("backgroundRequested", moveToBackground);
        killProcessTree(child);
        resolve(
          truncate(
            stdout +
              (stderr ? `\nStderr: ${stderr}` : "") +
              "\n\n[Command interrupted]",
          ),
        );
      };
      const signal = context?.signal;
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () =>
          signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          onAbort();
        }
      }

      const resetTimeout = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        timeoutId = setTimeout(() => {
          if (isResolved) return;
          isResolved = true;
          killProcessTree(child);
          let output = stdout + (stderr ? `\nStderr: ${stderr}` : "");
          output += `\n\n[Command timed out after ${TIMEOUT_MS / 1000} seconds of no output]`;

          const truncationResult = truncateOutputFromStart(output, {
            maxChars,
            maxLines,
          });
          const finalOutput = truncationResult.wasTruncated
            ? appendParallelLimitNote(truncationResult.output)
            : truncationResult.output;
          resolve(finalOutput);
        }, TIMEOUT_MS);
      };

      const showCurrentOutput = () => {
        if (!context?.toolCallId) return;
        try {
          const currentOutput = stdout + (stderr ? `\nStderr: ${stderr}` : "");
          services.chatHistory.addToolResult(
            context.toolCallId,
            truncate(currentOutput),
            "calling",
          );
        } catch {
          // Ignore errors during streaming updates
        }
      };

      // Start the initial timeout
      resetTimeout();

      const onStdout = (data: Buffer) => {
        stdout = appendToTail(stdout, data.toString(), bufferLimit);
        resetTimeout();
        showCurrentOutput();
      };

      const onStderr = (data: Buffer) => {
        stderr = appendToTail(stderr, data.toString(), bufferLimit);
        resetTimeout();
        showCurrentOutput();
      };

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);

      let drainTimer: NodeJS.Timeout | undefined;

      child.on("exit", (code) => {
        if (isResolved) return;
        drainTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(code);
        }, OUTPUT_DRAIN_MS);
      });

      child.on("close", (code) => {
        clearTimeout(drainTimer);
        finish(code);
      });

      const finish = (code: number | null) => {
        if (isResolved) return;
        isResolved = true;

        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        backgroundSignalManager.removeListener(
          "backgroundRequested",
          moveToBackground,
        );

        // Only reject on non-zero exit code if there's also stderr
        if (code !== 0 && stderr) {
          reject(`Error (exit code ${code}): ${truncate(stderr)}`);
          return;
        }

        // Track specific git operations only after successful execution
        if (code === 0) {
          if (isGitCommitCommand(command)) {
            telemetryService.recordCommitCreated();
          } else if (isPullRequestCommand(command)) {
            telemetryService.recordPullRequestCreated();
          }
        }

        let output = stdout;
        if (stderr) {
          output = stdout + `\nStderr: ${stderr}`;
        }

        const truncationResult = truncateOutputFromStart(output, {
          maxChars,
          maxLines,
        });
        const finalOutput = truncationResult.wasTruncated
          ? appendParallelLimitNote(truncationResult.output)
          : truncationResult.output;
        resolve(finalOutput);
      };

      child.on("error", (error) => {
        if (isResolved) return;
        isResolved = true;

        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        backgroundSignalManager.off("backgroundRequested", moveToBackground);
        reject(`Error: ${error.message}`);
      });
    });

    let terminalOutput: string;
    try {
      terminalOutput = await outputPromise;
    } finally {
      removeAbortListener();
    }

    emitBashToolEnded();

    return terminalOutput;
  },
};
