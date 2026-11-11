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

// Defaults also apply to a value passed as undefined (an absent flag)
function withDefaults({
  passEnv = [],
  allowPrivateFetch = false,
}: Partial<RunSafetyOptions> = {}): RunSafetyOptions {
  return { passEnv, allowPrivateFetch };
}

let current = withDefaults();

export function setRunSafetyOptions(options: Partial<RunSafetyOptions>): void {
  current = withDefaults(options);
}

export function getRunSafetyOptions(): RunSafetyOptions {
  return current;
}
