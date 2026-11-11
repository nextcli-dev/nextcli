import { getRunSafetyOptions } from "../tools/runSafetyOptions.js";

import { logger } from "./logger.js";

// Names that hold a secret, matched case-insensitively anywhere in the name
const SECRET_NAME_PARTS = [
  "API_KEY",
  "APIKEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "PRIVATE_KEY",
  "CREDENTIAL",
  "ACCESS_KEY",
];

// Names that end like a secret (OPENAI_KEY, GITLAB_PAT)
const SECRET_NAME_SUFFIX = /_(KEY|PAT)$/i;

// Names that match a pattern above but hold no secret
const KEPT_NAMES = new Set(["TOKENIZERS_PARALLELISM"]);

// Values that are a credential whatever the variable is called
const SECRET_VALUE_PATTERNS = [
  /^sk-[A-Za-z0-9_-]{8,}/, // OpenAI, Anthropic, DeepSeek and others
  /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, // GitHub tokens
  /^github_pat_[A-Za-z0-9_]{20,}/,
  /^glpat-[A-Za-z0-9_-]{20,}/, // GitLab
  /^xox[abpr]-[A-Za-z0-9-]{10,}/, // Slack
  /^(AKIA|ASIA)[A-Z0-9]{16}$/, // AWS access key id
  /^AIza[A-Za-z0-9_-]{35}$/, // Google API key
  /^hf_[A-Za-z0-9]{20,}/, // Hugging Face
  /^npm_[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i, // URL with a password
];

/** Whether an environment variable holds a secret the shell shouldn't see */
export function isSecretEnvVar(
  name: string,
  value: string | undefined,
): boolean {
  const upper = name.toUpperCase();
  if (KEPT_NAMES.has(upper)) {
    return false;
  }
  if (
    SECRET_NAME_SUFFIX.test(upper) ||
    SECRET_NAME_PARTS.some((part) => upper.includes(part))
  ) {
    return true;
  }
  return (
    value !== undefined &&
    SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))
  );
}

let loggedStripped = false;

/**
 * The environment for shell commands the model runs: this process's
 * environment without secret-like variables, so a prompt injection can't read
 * the provider key or a CI token with `env`. Names in `passEnv` (--pass-env)
 * are kept. Commands from the user's own config (hooks, MCP servers) don't use
 * this.
 */
export function childProcessEnv(
  passEnv: string[] = getRunSafetyOptions().passEnv,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const passed = new Set(passEnv.map((name) => name.toUpperCase()));
  const result: NodeJS.ProcessEnv = {};
  const stripped: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!passed.has(name.toUpperCase()) && isSecretEnvVar(name, value)) {
      stripped.push(name);
    } else {
      result[name] = value;
    }
  }
  if (stripped.length > 0 && !loggedStripped) {
    loggedStripped = true;
    logger.debug(
      `Shell commands run without these environment variables: ${stripped.sort().join(", ")}. Use --pass-env to keep one.`,
    );
  }
  return result;
}
