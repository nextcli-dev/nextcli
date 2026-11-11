import fs from "fs";
import path from "path";
import readline from "readline";

import dotenv from "dotenv";

import { logger } from "./util/logger.js";
import {
  continueHomeDir,
  hasProjectEnvFiles,
  PROJECT_ENV_FILES,
  setStoredTrust,
  trustDecision,
} from "./workspaceTrust.js";

/**
 * Called from the preAction hook in index.ts, once commander knows the
 * command. It decides whether the working directory is trusted, asks once in
 * an interactive chat, and loads .env files: the trusted folder's
 * .continue/.env and .env, then ~/.continue/.env. Variables already set win.
 *
 * Loading here rather than before any import is enough: the variables read at
 * module load are ones a .env may never set (CONTINUE_GLOBAL_DIR,
 * NEXTCLI_API_BASE) plus NEXTCLI_LOG_LEVEL, which the preAction hook
 * re-applies with logger.setLevel. NEXTCLI_TRACE is read at the first trace
 * event.
 */

// Never taken from a .env file, trusted or not: they change how processes
// start, where traffic goes or where cn keeps its configuration. They still
// work from the real environment.
const NEVER_FROM_FILE = [
  /^NODE_OPTIONS$/,
  /^NODE_PATH$/,
  /^NODE_EXTRA_CA_CERTS$/,
  /^NODE_TLS_REJECT_UNAUTHORIZED$/,
  // npm's settings, including the registry cn's self-update installs from
  /^NPM_CONFIG_/,
  /^LD_/,
  /^DYLD_/,
  /^PATH$/,
  /^HOME$/,
  /^SHELL$/,
  /^BASH_ENV$/,
  /^ENV$/,
  /^GIT_/,
  /^(HTTP|HTTPS|ALL|NO)_PROXY$/,
  /^CONTINUE_GLOBAL_DIR$/,
  /^NEXTCLI_TRUST_WORKSPACE$/,
  /^NEXTCLI_VERSION_INFO_URL$/,
  /^NEXTCLI_API_BASE$/,
  /^OTEL_/,
  /^CONTINUE_CLI_ENABLE_TELEMETRY$/,
];

export function isNeverFromFile(name: string): boolean {
  const upper = name.toUpperCase();
  return NEVER_FROM_FILE.some((pattern) => pattern.test(upper));
}

/** What loadProjectEnvironment did, logged once the log level is set */
export interface EnvironmentReport {
  trusted: boolean;
  loaded: string[];
  skippedNames: string[];
}

/** Sets variables from a .env file that aren't set yet */
function loadEnvFile(
  file: string,
  env: NodeJS.ProcessEnv,
  skipped: Set<string>,
): boolean {
  let parsed: Record<string, string>;
  try {
    parsed = dotenv.parse(fs.readFileSync(file));
  } catch {
    return false;
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (isNeverFromFile(name)) {
      skipped.add(name);
    } else if (env[name] === undefined) {
      env[name] = value;
    }
  }
  return true;
}

/** The person's answer, or undefined when they closed the prompt (Ctrl+D) */
function askToTrust(folder: string): Promise<boolean | undefined> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    // Closing without an answer drops the question's callback; settle anyway
    // so cn still starts
    rl.once("close", () => resolve(undefined));
    rl.question(
      `Trust ${folder}? Its .env and .continue/.env can set environment variables for cn. [y/N] `,
      (answer) => {
        resolve(/^y(es)?$/i.test(answer.trim()));
        rl.close();
      },
    );
  });
}

/**
 * Whether this run may ask: only the interactive chat (`cn` without -p or a
 * subcommand) with a terminal to answer in. Every other run, cn review and
 * CI included, never asks.
 */
export function canAskForTrust(options: {
  interactiveChat: boolean;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  env: NodeJS.ProcessEnv;
}): boolean {
  return (
    options.interactiveChat &&
    options.stdinIsTTY &&
    options.stdoutIsTTY &&
    options.env.FORCE_NO_TTY !== "true"
  );
}

export async function loadProjectEnvironment(options: {
  canAsk: boolean;
  /** --trust-workspace */
  trustFlag: boolean;
  /** No "skipped" notice: cn trust and cn untrust manage trust themselves */
  quietNotice?: boolean;
  folder?: string;
  env?: NodeJS.ProcessEnv;
  /** Where the "skipped" notice goes; headless runs block process.stderr */
  notice?: (message: string) => void;
  ask?: (folder: string) => Promise<boolean | undefined>;
}): Promise<EnvironmentReport> {
  const folder = options.folder ?? process.cwd();
  const env = options.env ?? process.env;
  const notice =
    options.notice ?? ((message: string) => process.stderr.write(message));
  // Decided from the real environment, before any file is read
  const userEnvFile = path.join(continueHomeDir(env), ".env");

  const decision = trustDecision({
    folder,
    env,
    trustFlag: options.trustFlag,
    canAsk: options.canAsk,
  });
  let trusted = decision === "trusted";
  if (decision === "ask") {
    const answer = await (options.ask ?? askToTrust)(folder);
    trusted = answer === true;
    // No answer: untrusted for this run, and cn asks again next time
    if (answer !== undefined) {
      try {
        setStoredTrust(folder, answer, env);
      } catch (error) {
        // This run still follows the answer; cn asks again next time
        logger.debug("Couldn't save the trust decision", error);
      }
    }
  }

  const loaded: string[] = [];
  const skipped = new Set<string>();
  if (trusted) {
    for (const file of PROJECT_ENV_FILES) {
      const full = path.join(folder, file);
      if (loadEnvFile(full, env, skipped)) loaded.push(full);
    }
  } else if (!options.quietNotice && hasProjectEnvFiles(folder)) {
    notice(
      "Skipped this folder's .env: the folder isn't trusted (run `cn trust`, or pass --trust-workspace for one run).\n",
    );
  }
  if (loadEnvFile(userEnvFile, env, skipped)) loaded.push(userEnvFile);

  return { trusted, loaded, skippedNames: [...skipped].sort() };
}
