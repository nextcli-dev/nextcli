import fs from "fs";
import path from "path";
import readline from "readline";

import dotenv from "dotenv";

import {
  continueHomeDir,
  hasProjectEnvFiles,
  isInteractiveRun,
  PROJECT_ENV_FILES,
  setStoredTrust,
  trustDecision,
} from "./workspaceTrust.js";

/**
 * Runs before the rest of cn is imported (dist/cn.js), because many modules
 * read process.env when they load. It decides whether the working directory
 * is trusted, asks once in an interactive run, and loads .env files:
 * the trusted folder's .continue/.env and .env, then ~/.continue/.env.
 * Variables already set win, as before.
 */

// Never taken from a .env file, trusted or not: they change how processes
// start, where traffic goes or where cn keeps its configuration. They still
// work from the real environment.
const NEVER_FROM_FILE = [
  /^NODE_OPTIONS$/,
  /^NODE_PATH$/,
  /^NODE_EXTRA_CA_CERTS$/,
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

/** What the bootstrap did, for the CLI to log once its logger exists */
export interface EnvironmentReport {
  trusted: boolean;
  loaded: string[];
  skippedNames: string[];
}

declare global {
  // eslint-disable-next-line no-var
  var __nextcliEnvironmentReport: EnvironmentReport | undefined;
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

function askToTrust(
  folder: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    rl.question(
      `Trust ${folder}? Its .env and .continue/.env can set environment variables for cn. [y/N] `,
      (answer) => {
        rl.close();
        resolve(/^y(es)?$/i.test(answer.trim()));
      },
    );
  });
}

export async function prepareEnvironment(
  options: {
    folder?: string;
    argv?: readonly string[];
    env?: NodeJS.ProcessEnv;
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
    stderr?: NodeJS.WritableStream;
    ask?: (folder: string) => Promise<boolean>;
  } = {},
): Promise<EnvironmentReport> {
  const folder = options.folder ?? process.cwd();
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  // Decided from the real environment, before any file is read
  const userEnvFile = path.join(continueHomeDir(env), ".env");

  const decision = trustDecision({
    folder,
    argv,
    env,
    interactive: isInteractiveRun(
      argv,
      !!stdin.isTTY && env.FORCE_NO_TTY !== "true",
      !!stdout.isTTY,
    ),
  });
  let trusted = decision === "trusted";
  if (decision === "ask") {
    const ask =
      options.ask ?? ((dir: string) => askToTrust(dir, stdin, stdout));
    trusted = await ask(folder);
    setStoredTrust(folder, trusted, env);
  }

  const loaded: string[] = [];
  const skipped = new Set<string>();
  if (trusted) {
    for (const file of PROJECT_ENV_FILES) {
      const full = path.join(folder, file);
      if (loadEnvFile(full, env, skipped)) loaded.push(full);
    }
  } else if (
    hasProjectEnvFiles(folder) &&
    !argv.includes("--internal-review-worker")
  ) {
    stderr.write(
      "Skipped this folder's .env: the folder isn't trusted (run `cn trust`, or pass --trust-workspace for one run).\n",
    );
  }
  if (loadEnvFile(userEnvFile, env, skipped)) loaded.push(userEnvFile);

  const report = { trusted, loaded, skippedNames: [...skipped].sort() };
  globalThis.__nextcliEnvironmentReport = report;
  return report;
}
