#!/usr/bin/env node

// MUST be the first import - intercepts console/stdout/stderr before any dependencies load
import "./init.js";

import { Command } from "commander";

import { chat } from "./commands/chat.js";
import { checks } from "./commands/checks.js";
import { cleanupCommand } from "./commands/cleanup.js";
import { listSessionsCommand } from "./commands/ls.js";
import { review } from "./commands/review.js";
import { serve } from "./commands/serve.js";
import {
  handleValidationErrors,
  validateFlags,
} from "./flags/flagValidator.js";
import { configureConsoleForHeadless, safeStderr } from "./init.js";
import {
  canAskForTrust,
  loadProjectEnvironment,
  type EnvironmentReport,
} from "./projectEnv.js";
import { addCommonOptions, mergeParentOptions } from "./shared-options.js";
import { post } from "./util/apiClient.js";
import { markUnhandledError } from "./util/errorState.js";
import { gracefulExit } from "./util/exit.js";
import { logger, parseLogLevel } from "./util/logger.js";
import { signalForegroundProcessTrees } from "./util/processTree.js";
import { readStdinSync } from "./util/stdin.js";
import { getVersion } from "./version.js";
import { listStoredTrust, setStoredTrust } from "./workspaceTrust.js";

// TUI lifecycle and two-stage exit state management
let tuiUnmount: (() => void) | null;
let showExitMessage: boolean;
let exitMessageCallback: (() => void) | null;
let lastCtrlCTime: number;

// Agent ID for serve mode - set when serve command is invoked with --id
let agentId: string | undefined;

// Initialize state immediately to avoid temporal dead zone issues with exported functions
(function initializeTUIState() {
  tuiUnmount = null;
  showExitMessage = false;
  exitMessageCallback = null;
  lastCtrlCTime = 0;
})();

// Set the agent ID for error reporting (called by serve command)
export function setAgentId(id: string | undefined) {
  agentId = id;
}

// Register TUI cleanup function for graceful shutdown
export function setTUIUnmount(unmount: () => void) {
  tuiUnmount = unmount;
}

// Register callback to trigger UI updates when exit message state changes
export function setExitMessageCallback(callback: () => void) {
  exitMessageCallback = callback;
}

// Sets up SIGINT handler that requires double Ctrl+C within 1 second to exit
export function enableSigintHandler() {
  // Remove all existing SIGINT listeners first
  process.removeAllListeners("SIGINT");

  process.on("SIGINT", async () => {
    // The running command's shell is in its own process group
    signalForegroundProcessTrees("SIGINT");
    const now = Date.now();
    const timeSinceLastCtrlC = now - lastCtrlCTime;

    if (timeSinceLastCtrlC <= 1000 && lastCtrlCTime !== 0) {
      // Second Ctrl+C within 1 second - exit
      showExitMessage = false;
      if (tuiUnmount) {
        tuiUnmount();
      }
      await gracefulExit(0);
    } else {
      // First Ctrl+C or too much time elapsed - show exit message
      lastCtrlCTime = now;
      showExitMessage = true;
      if (exitMessageCallback) {
        exitMessageCallback();
      }

      // Hide message after 1 second
      setTimeout(() => {
        showExitMessage = false;
        if (exitMessageCallback) {
          exitMessageCallback();
        }
      }, 1000);
    }
  });
}

// Check if "ctrl+c to exit" message should be displayed
export function shouldShowExitMessage(): boolean {
  return showExitMessage;
}

// Helper to report unhandled errors to the API when running in serve mode
async function reportUnhandledErrorToApi(error: Error): Promise<void> {
  if (!agentId) {
    // Not running in serve mode with an agent ID, skip API reporting
    return;
  }

  try {
    await post(`agents/${agentId}/status`, {
      status: "FAILED",
      errorMessage: `Unhandled error: ${error.message}`,
    });
    logger.debug(`Reported unhandled error to API for agent ${agentId}`);
  } catch (apiError) {
    // If API reporting fails, just log it - don't crash
    logger.debug(
      `Failed to report error to API: ${apiError instanceof Error ? apiError.message : String(apiError)}`,
    );
  }
}

// Add global error handlers to prevent uncaught errors from crashing the process
process.on("unhandledRejection", (reason, promise) => {
  // Mark that an unhandled error occurred - this will cause non-zero exit
  markUnhandledError();

  // Extract useful information from the reason
  const errorDetails = {
    promiseString: String(promise),
    reasonType: typeof reason,
    reasonConstructor: reason?.constructor?.name,
  };

  // If reason is an Error, use it directly for better stack traces
  if (reason instanceof Error) {
    logger.error("Unhandled Promise Rejection", reason, errorDetails);
    // Report to API if running in serve mode
    reportUnhandledErrorToApi(reason).catch(() => {
      // Silently fail if API reporting errors - already logged in helper
    });
  } else {
    // Convert non-Error reasons to Error for consistent handling
    const error = new Error(`Unhandled rejection: ${String(reason)}`);
    logger.error("Unhandled Promise Rejection", error, {
      ...errorDetails,
      originalReason: String(reason),
    });
    // Report to API if running in serve mode
    reportUnhandledErrorToApi(error).catch(() => {
      // Silently fail if API reporting errors - already logged in helper
    });
  }

  // Don't exit the process immediately, but hasUnhandledError will cause non-zero exit later
});

process.on("uncaughtException", (error) => {
  // Mark that an unhandled error occurred - this will cause non-zero exit
  markUnhandledError();

  logger.error("Uncaught Exception:", error);
  // Report to API if running in serve mode
  reportUnhandledErrorToApi(error).catch(() => {
    // Silently fail if API reporting errors - already logged in helper
  });
  // Don't exit the process immediately, but hasUnhandledError will cause non-zero exit later
});

// keyboard interruption handler for non-TUI flows
process.on("SIGINT", async () => {
  // Like a terminal would, interrupt the running command first: its shell is
  // in its own process group (gracefulExit then kills every tree)
  signalForegroundProcessTrees("SIGINT");
  await gracefulExit(130);
});

// Ctrl+Z: stop the running command along with the CLI, and resume it with it
if (process.platform !== "win32") {
  process.on("SIGTSTP", () => {
    // SIGSTOP, because the kernel ignores SIGTSTP in the shell's own session
    // (an orphaned process group)
    signalForegroundProcessTrees("SIGSTOP");
    process.kill(process.pid, "SIGSTOP");
  });
  process.on("SIGCONT", () => {
    signalForegroundProcessTrees("SIGCONT");
  });
}

const program = new Command();

program
  .name("cn")
  .description(
    "NextCLI CLI - AI-powered development assistant. Starts an interactive session by default, use -p/--print for non-interactive output.",
  )
  .version(getVersion(), "-v, --version", "Display version number");

function logEnvironmentReport(report: EnvironmentReport): void {
  logger.debug("Environment files", {
    trusted: report.trusted,
    loaded: report.loaded,
  });
  if (report.skippedNames.length > 0) {
    logger.debug(
      `Not taken from a .env file: ${report.skippedNames.join(", ")}. Set them in the environment instead.`,
    );
  }
}

// Runs once commander knows the command, before its action: decides folder
// trust, loads .env files (src/projectEnv.ts), then sets the log level.
// --help and --version exit before this, so they never ask.
program.hook("preAction", async (_program, actionCommand) => {
  const opts = actionCommand.optsWithGlobals();
  const report = await loadProjectEnvironment({
    canAsk: canAskForTrust({
      interactiveChat: actionCommand === program && !opts.print,
      stdinIsTTY: !!process.stdin.isTTY,
      stdoutIsTTY: !!process.stdout.isTTY,
      env: process.env,
    }),
    trustFlag: !!opts.trustWorkspace,
    quietNotice: ["trust", "untrust"].includes(actionCommand.name()),
    notice: safeStderr,
  });

  // --log-level wins over --verbose, which wins over NEXTCLI_LOG_LEVEL (which
  // a trusted folder's .env may set)
  const level =
    opts.logLevel ??
    (opts.verbose ? "debug" : undefined) ??
    parseLogLevel(process.env.NEXTCLI_LOG_LEVEL);
  if (level) {
    logger.setLevel(level);
  }
  logEnvironmentReport(report);
});

// Root command - chat functionality (default)
// Add common options to the root command
addCommonOptions(program)
  .argument("[prompt]", "Optional prompt to send to the assistant")
  .option("-p, --print", "Print response and exit (useful for pipes)")
  .option(
    "--format <format>",
    "Output format for headless mode (json). Only works with -p/--print flag.",
  )
  .option(
    "--silent",
    "Strip <think></think> tags and excess whitespace from output. Only works with -p/--print flag.",
  )
  .option("--resume", "Resume from last session")
  .option("--fork <sessionId>", "Fork from an existing session ID")
  .option(
    "--beta-subagent-tool",
    "Enable beta Subagent tool for invoking subagents",
  )
  .action(async (prompt, options) => {
    // Handle piped input - detect it early and decide on mode
    let stdinInput = null;

    if (!options.print) {
      // Check if there's piped input available
      stdinInput = readStdinSync();
      if (stdinInput) {
        // Use piped input as the initial prompt
        if (prompt) {
          // Combine stdin and prompt argument
          prompt = `${stdinInput}\n\n${prompt}`;
        } else {
          // Only stdin input, use as initial prompt
          prompt = stdinInput;
        }

        // We have piped input but want to use TUI mode
        // Store a flag to pass custom stdin to TUI
        (options as any).hasPipedInput = true;
      }
    }

    // Configure console overrides FIRST, before any other logging
    const isHeadless = options.print;
    configureConsoleForHeadless(isHeadless);
    logger.configureHeadlessMode(isHeadless);

    // Validate all command line flags
    const validation = validateFlags({
      print: options.print,
      format: options.format,
      silent: options.silent,
      readonly: options.readonly,
      auto: options.auto,
      config: options.config,
      resume: options.resume,
      fork: options.fork,
      allow: options.allow,
      ask: options.ask,
      exclude: options.exclude,
      isRootCommand: true,
      commandName: "cn",
    });

    if (!validation.isValid) {
      handleValidationErrors(validation.errors);
    }

    if (logger.isLevelEnabled("debug") && !isHeadless) {
      const logPath = logger.getLogPath();
      const runId = logger.getRunId();
      console.log(`Verbose logging enabled (run: ${runId})`);
      console.log(`Logs: ${logPath}`);
      console.log(`Filter this run: grep '\\[${runId}\\]' ${logPath}`);
    }

    // Handle piped input for headless mode (only if we haven't already read it)
    if (options.print && !stdinInput) {
      const headlessStdinInput = readStdinSync();
      if (headlessStdinInput) {
        if (prompt) {
          // Combine stdin and prompt argument - stdin comes first in XML block
          prompt = `<stdin>\n${headlessStdinInput}\n</stdin>\n\n${prompt}`;
        } else {
          // Only stdin input, use as-is
          prompt = headlessStdinInput;
        }
      }
    }

    // In headless mode, ensure we have a prompt unless using --agent flag or --resume flag
    // Agent files can provide their own prompts, and resume can work without new input
    if (options.print && !prompt && !options.agent && !options.resume) {
      safeStderr(
        "Error: A prompt is required when using the -p/--print flag, unless --prompt, --agent, or --resume is provided.\n\n",
      );
      safeStderr("Usage examples:\n");
      safeStderr('  cn -p "please review my current git diff"\n');
      safeStderr('  echo "hello" | cn -p\n');
      safeStderr('  cn -p "analyze the code in src/"\n');
      safeStderr("  cn -p --agent my-org/my-agent\n");
      safeStderr("  cn -p --prompt my-org/my-prompt\n");
      safeStderr("  cn -p --resume\n");
      await gracefulExit(1);
    }

    // Map --print to headless mode
    options.headless = options.print;
    options.print = undefined;
    await chat(prompt, options);
  });

// List sessions subcommand
program
  .command("ls")
  .description("List recent chat sessions and select one to resume")
  .option("--json", "Output in JSON format")
  .action(async (options) => {
    await listSessionsCommand({
      format: options.json ? "json" : undefined,
    });
  });

// Cleanup subcommand
program
  .command("cleanup")
  .description(
    "Delete the codebase index and @docs data older versions left in ~/.continue/index",
  )
  .option("-y, --yes", "Delete without asking")
  .action(async (options) => {
    await cleanupCommand({ yes: options.yes });
  });

// Folder trust: whether a folder's .env and .continue/.env may set cn's
// environment (src/workspaceTrust.ts)
program
  .command("trust [folder]")
  .description(
    "Trust a folder (default: this one), so its .env and .continue/.env load",
  )
  .option("--list", "List the folders you trusted or refused")
  .action((folder: string | undefined, options: { list?: boolean }) => {
    if (options.list) {
      const folders = Object.entries(listStoredTrust());
      if (folders.length === 0) console.log("No folders trusted or refused.");
      for (const [dir, trusted] of folders) {
        console.log(`${trusted ? "trusted" : "refused"}  ${dir}`);
      }
      return;
    }
    const dir = setStoredTrust(folder ?? process.cwd(), true);
    console.log(`Trusted ${dir}. Its .env files load from the next run.`);
  });

program
  .command("untrust [folder]")
  .description(
    "Stop trusting a folder (default: this one), even if a parent folder is trusted",
  )
  .action((folder: string | undefined) => {
    const dir = setStoredTrust(folder ?? process.cwd(), false);
    console.log(
      `${dir} is no longer trusted. Run \`cn trust\` to trust it again.`,
    );
  });

// Serve subcommand
program
  .command("serve [prompt]", { hidden: true })
  .description("Start an HTTP server with /state and /message endpoints")
  .option(
    "--timeout <seconds>",
    "Inactivity timeout in seconds (default: 300)",
    "300",
  )
  .option("--port <port>", "Port to run the server on (default: 8000)", "8000")
  .option(
    "--id <storageId>",
    "Upload session snapshots to Continue-managed storage using the provided identifier",
  )
  .option(
    "--beta-upload-artifact-tool",
    "Enable beta UploadArtifact tool for uploading screenshots, videos, and logs",
  )
  .action(async (prompt, options) => {
    // Merge parent options with subcommand options
    const mergedOptions = mergeParentOptions(program, options);
    await serve(prompt, mergedOptions);
  });

// Checks subcommand
program
  .command("checks [action] [pr-url]")
  .description("Show CI check statuses for a PR")
  .action(async (action: string | undefined, prUrl: string | undefined) => {
    await checks(action, prUrl);
  });

// Review subcommand
program
  .command("review")
  .description("Run AI-powered reviews on your changes")
  .option("--base <ref>", "Base git ref to diff against (default: auto-detect)")
  .option("--format <format>", "Output format")
  .option("--fix", "Automatically apply suggested fixes")
  .option("--patch", "Show patches")
  .option("--fail-fast", "Stop on first failure")
  .option("--review-agents <agents...>", "Specific review agents to run")
  .option("--verbose", "Enable verbose logging")
  .action(async (options) => {
    // --config, --org and --rule belong to the root command
    await review(mergeParentOptions(program, options));
  });

// Handle unknown commands
program.on("command:*", () => {
  console.error(`Error: Unknown command '${program.args.join(" ")}'\n`);
  program.outputHelp();
  void gracefulExit(1);
});

export async function runCli(): Promise<void> {
  // Handle internal worker subprocess for cn review
  if (process.argv.includes("--internal-review-worker")) {
    const { runReviewWorker } = await import(
      "./commands/review/reviewWorker.js"
    );
    await runReviewWorker();
    return;
  }

  // Parse arguments and handle errors
  try {
    program.parse();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }

  process.on("SIGTERM", async () => {
    await gracefulExit(0);
  });
}
