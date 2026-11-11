import fs from "fs";
import os from "os";
import path from "path";

/**
 * Folder trust: whether files in the working directory may configure cn.
 * A repository cn reviews, a pull request's checkout in CI for example, is
 * written by someone else, so its .env must not set cn's environment. The
 * person decides once per folder; the decision is stored outside the folder.
 *
 * This file is bundled into the bootstrap (dist/bootstrap.js) as well as the
 * CLI, so it imports only Node built-ins and keeps no state.
 */

export type TrustDecision = "trusted" | "untrusted" | "ask";

interface TrustStore {
  /** Real path of a folder → whether the person trusted it */
  folders: Record<string, boolean>;
}

/** Files a trusted folder may load environment variables from */
export const PROJECT_ENV_FILES = [path.join(".continue", ".env"), ".env"];

// Commands that never ask: nobody may be there to answer, or the command
// manages trust itself
const NON_INTERACTIVE_ARGS = new Set([
  "-p",
  "--print",
  "--internal-review-worker",
  "review",
  "serve",
  "checks",
  "ls",
  "cleanup",
  "trust",
  "untrust",
]);

/**
 * The real environment's config directory. Called before any .env is loaded,
 * so a repository can't move it.
 */
export function continueHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CONTINUE_GLOBAL_DIR;
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), ".continue");
}

export function trustStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(continueHomeDir(env), "trusted-folders.json");
}

function realFolder(folder: string): string {
  try {
    return fs.realpathSync(folder);
  } catch {
    return path.resolve(folder);
  }
}

function readStore(storePath: string): TrustStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    if (parsed && typeof parsed.folders === "object" && parsed.folders) {
      return { folders: parsed.folders };
    }
  } catch {
    // Missing or unreadable: nothing is trusted
  }
  return { folders: {} };
}

/** The stored decision for a folder or the nearest parent that has one */
export function storedTrust(
  folder: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  const { folders } = readStore(trustStorePath(env));
  let current = realFolder(folder);
  for (;;) {
    const decision = folders[current];
    if (typeof decision === "boolean") return decision;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Saves a decision for a folder; undefined forgets it */
export function setStoredTrust(
  folder: string,
  trusted: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const storePath = trustStorePath(env);
  const store = readStore(storePath);
  const key = realFolder(folder);
  if (trusted === undefined) {
    delete store.folders[key];
  } else {
    store.folders[key] = trusted;
  }
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
  });
  return key;
}

/** Every stored decision, for `cn trust --list` */
export function listStoredTrust(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, boolean> {
  return readStore(trustStorePath(env)).folders;
}

export function hasProjectEnvFiles(folder: string): boolean {
  return PROJECT_ENV_FILES.some((file) =>
    fs.existsSync(path.join(folder, file)),
  );
}

/** Whether this run can ask the person a question */
export function isInteractiveRun(
  argv: readonly string[],
  stdinIsTTY: boolean,
  stdoutIsTTY: boolean,
): boolean {
  if (!stdinIsTTY || !stdoutIsTTY) return false;
  return !argv.slice(2).some((arg) => NON_INTERACTIVE_ARGS.has(arg));
}

/** Whether the person passed trust for this run only */
export function trustedForThisRun(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    argv.includes("--trust-workspace") ||
    env.NEXTCLI_TRUST_WORKSPACE === "1" ||
    env.NEXTCLI_TRUST_WORKSPACE === "true"
  );
}

/**
 * Whether files in `folder` may configure cn:
 * 1. --trust-workspace or NEXTCLI_TRUST_WORKSPACE=1: trusted, this run only;
 * 2. a stored decision for the folder or a parent;
 * 3. a run that can't ask (headless, cn review, no terminal): untrusted;
 * 4. "ask" if the folder has a file trust would load, else untrusted.
 */
export function trustDecision(options: {
  folder: string;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  interactive: boolean;
}): TrustDecision {
  const { folder, argv, env, interactive } = options;
  if (trustedForThisRun(argv, env)) return "trusted";
  const stored = storedTrust(folder, env);
  if (stored !== undefined) return stored ? "trusted" : "untrusted";
  if (!interactive) return "untrusted";
  return hasProjectEnvFiles(folder) ? "ask" : "untrusted";
}

/**
 * Whether the working directory is trusted in this run. The bootstrap has
 * already saved the person's answer, so "ask" can't come back here.
 */
export function isWorkspaceTrusted(
  folder: string = process.cwd(),
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return trustDecision({ folder, argv, env, interactive: false }) === "trusted";
}
