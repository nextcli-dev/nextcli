/**
 * Per-run choices that loosen the guards on Bash and Fetch. They are set once
 * from the command line (--pass-env, --allow-private-fetch); every other
 * process, including the `cn review` worker, keeps the safe defaults.
 */
export interface RunSafetyOptions {
  /** Secret-like environment variables to keep for shell commands */
  passEnv: string[];
  /** Let Fetch reach loopback and private addresses (never cloud metadata) */
  allowPrivateFetch: boolean;
}

const DEFAULTS: RunSafetyOptions = { passEnv: [], allowPrivateFetch: false };

let current: RunSafetyOptions = DEFAULTS;

export function setRunSafetyOptions(options: Partial<RunSafetyOptions>): void {
  current = {
    passEnv: options.passEnv ?? [],
    allowPrivateFetch: options.allowPrivateFetch ?? false,
  };
}

export function getRunSafetyOptions(): RunSafetyOptions {
  return current;
}
