import { filterSecretEnv } from "@continuedev/terminal-security";

import { getRunSafetyOptions } from "../tools/runSafetyOptions.js";

import { logger } from "./logger.js";

let loggedStripped = false;

/**
 * The environment for shell commands the model runs: this process's
 * environment without secret-like variables (the rules are in
 * @continuedev/terminal-security), so neither `env` nor the shell's own
 * /proc/<pid>/environ shows the provider key or a CI token. Names given with
 * --pass-env are kept. The shell profile can export keys again; the prelude
 * from getShellCommand removes those.
 */
export function childProcessEnv(): NodeJS.ProcessEnv {
  const { env, stripped } = filterSecretEnv(
    process.env,
    getRunSafetyOptions().passEnv,
  );
  if (stripped.length > 0 && !loggedStripped) {
    loggedStripped = true;
    logger.debug(
      `Shell commands run without these environment variables: ${stripped.join(", ")}. Use --pass-env to keep one.`,
    );
  }
  return env;
}
