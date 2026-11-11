import fs from "fs";
import os from "os";
import path from "path";

/**
 * Folder trust: whether files in the working directory may configure cn.
 * A repository cn reviews, a pull request's checkout in CI for example, is
 * written by someone else, so its .env must not set cn's environment. The
 * person decides once per folder; the decision is stored outside the folder.
 */

export type TrustDecision = "trusted" | "untrusted" | "ask";

interface TrustStore {
  /** Real path of a folder → whether the person trusted it */
  folders: Record<string, boolean>;
}

/** Files a trusted folder may load environment variables from */
export const PROJECT_ENV_FILES = [path.join(".continue", ".env"), ".env"];

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

/**
 * Saves a decision for a folder. It wins over a parent's decision, so
 * refusing a folder inside a trusted one works.
 */
export function setStoredTrust(
  folder: string,
  trusted: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const storePath = trustStorePath(env);
  const store = readStore(storePath);
  const key = realFolder(folder);
  store.folders[key] = trusted;
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

/** Whether NEXTCLI_TRUST_WORKSPACE trusts the folder for this run */
export function trustedByEnv(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NEXTCLI_TRUST_WORKSPACE === "1" ||
    env.NEXTCLI_TRUST_WORKSPACE === "true"
  );
}

/**
 * Whether files in `folder` may configure cn:
 * 1. --trust-workspace or NEXTCLI_TRUST_WORKSPACE=1: trusted, this run only;
 * 2. a stored decision for the folder or its nearest parent that has one;
 * 3. "ask" if the run can ask and the folder has a file trust would load;
 * 4. otherwise untrusted.
 */
export function trustDecision(options: {
  folder: string;
  env: NodeJS.ProcessEnv;
  trustFlag: boolean;
  canAsk: boolean;
}): TrustDecision {
  const { folder, env, trustFlag, canAsk } = options;
  if (trustFlag || trustedByEnv(env)) return "trusted";
  const stored = storedTrust(folder, env);
  if (stored !== undefined) return stored ? "trusted" : "untrusted";
  return canAsk && hasProjectEnvFiles(folder) ? "ask" : "untrusted";
}

// Set once per run, by the preAction hook in index.ts, after the person
// answered. Untrusted until then: the cn review worker never sets it.
let workspaceTrusted = false;

export function setWorkspaceTrusted(trusted: boolean): void {
  workspaceTrusted = trusted;
}

/** Whether the working directory is trusted in this run */
export function isWorkspaceTrusted(): boolean {
  return workspaceTrusted;
}
