import fs from "node:fs";
import path from "node:path";

/**
 * Which environment variables a shell command the model runs must not see:
 * provider keys, CI tokens, passwords. The rules are globs, so the same list
 * drives the filter applied before spawning (filterSecretEnv) and the step
 * that runs inside the shell after its profile, which may export keys again
 * (posixUnsetPrelude, powershellUnsetPrelude).
 *
 * Glob syntax: `*` any text, `?` one character, `[abc]` one of the listed
 * characters.
 */

/** Names that hold a secret, matched case-insensitively */
export const SECRET_NAME_GLOBS = [
  "*API_KEY*",
  "*APIKEY*",
  "*SECRET*",
  "*TOKEN*",
  "*PASSWORD*",
  "*PASSWD*",
  "*PRIVATE_KEY*",
  "*CREDENTIAL*",
  "*ACCESS_KEY*",
  "*_KEY",
  "*_PAT",
];

const anyChars = (count: number) => "?".repeat(count);

/** Values that are a credential whatever the variable is called */
export const SECRET_VALUE_GLOBS = [
  `sk-${anyChars(8)}*`, // OpenAI, Anthropic, DeepSeek and others
  `gh[pousr]_${anyChars(20)}*`, // GitHub tokens
  `github_pat_${anyChars(20)}*`,
  `glpat-${anyChars(20)}*`, // GitLab
  `xox[abpr]-${anyChars(10)}*`, // Slack
  `AKIA${anyChars(16)}`, // AWS access key id
  `ASIA${anyChars(16)}`,
  `AIza${anyChars(35)}`, // Google API key
  `hf_${anyChars(20)}*`, // Hugging Face
  `npm_${anyChars(20)}*`,
  "*-----BEGIN*PRIVATE KEY-----*",
  "*://*:*@*", // URL with a password
];

/** Names that match a rule above but hold no secret */
export const KEPT_ENV_NAMES = ["TOKENIZERS_PARALLELISM"];

function globToRegExp(glob: string, flags: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      source += "[\\s\\S]*";
    } else if (char === "?") {
      source += "[\\s\\S]";
    } else if (char === "[") {
      const end = glob.indexOf("]", i);
      source += glob.slice(i, end + 1);
      i = end;
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, flags);
}

const nameRegExps = SECRET_NAME_GLOBS.map((glob) => globToRegExp(glob, "i"));
const valueRegExps = SECRET_VALUE_GLOBS.map((glob) => globToRegExp(glob, ""));
const keptNames = new Set(KEPT_ENV_NAMES);

/**
 * A path to an existing file is a pointer to a credential, not the credential:
 * the shell can read the file anyway, so stripping the variable would only
 * break tools such as gcloud (GOOGLE_APPLICATION_CREDENTIALS).
 */
function isPathToFile(value: string): boolean {
  if (!path.isAbsolute(value)) return false;
  try {
    return fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

/** Whether an environment variable holds a secret the shell shouldn't see */
export function isSecretEnvVar(
  name: string,
  value: string | undefined,
): boolean {
  if (keptNames.has(name.toUpperCase())) return false;
  const matches =
    nameRegExps.some((pattern) => pattern.test(name)) ||
    (value !== undefined &&
      valueRegExps.some((pattern) => pattern.test(value)));
  return matches && !(value !== undefined && isPathToFile(value));
}

/** Names a caller asked to keep, upper-cased; invalid names are dropped */
function keepSet(keep: readonly string[]): Set<string> {
  return new Set(
    keep
      .map((name) => name.trim().toUpperCase())
      .filter((name) => /^[A-Z_][A-Z0-9_]*$/.test(name)),
  );
}

/**
 * A copy of `env` without secret-like variables. Names in `keep` (for example
 * from --pass-env) are kept, matched case-insensitively.
 */
export function filterSecretEnv(
  env: NodeJS.ProcessEnv,
  keep: readonly string[] = [],
): { env: NodeJS.ProcessEnv; stripped: string[] } {
  const kept = keepSet(keep);
  const result: NodeJS.ProcessEnv = {};
  const stripped: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!kept.has(name.toUpperCase()) && isSecretEnvVar(name, value)) {
      stripped.push(name);
    } else {
      result[name] = value;
    }
  }
  return { env: result, stripped: stripped.sort() };
}

/** A glob as a POSIX `case` pattern, case-insensitive if asked */
function toCasePattern(glob: string, ignoreCase: boolean): string {
  let pattern = "";
  let literal = "";
  const flush = () => {
    if (literal) pattern += `'${literal}'`;
    literal = "";
  };
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" || char === "?") {
      flush();
      pattern += char;
    } else if (char === "[") {
      flush();
      const end = glob.indexOf("]", i);
      pattern += glob.slice(i, end + 1);
      i = end;
    } else if (ignoreCase && /[A-Za-z]/.test(char)) {
      flush();
      pattern += `[${char.toUpperCase()}${char.toLowerCase()}]`;
    } else {
      literal += char;
    }
  }
  flush();
  return pattern;
}

/**
 * POSIX shell code that unsets secret-like variables, for a login shell to run
 * after its profile and before the command: `$SHELL -l -c "<prelude>\n<cmd>"`.
 * It works in sh, bash, zsh, dash and ksh. It needs `awk` to list the
 * variables; without it nothing is unset.
 */
export function posixUnsetPrelude(keep: readonly string[] = []): string {
  const keepPatterns = [...keepSet(keep), ...KEPT_ENV_NAMES].map((name) =>
    toCasePattern(name, true),
  );
  const namePatterns = SECRET_NAME_GLOBS.map((glob) =>
    toCasePattern(glob, true),
  );
  const valuePatterns = SECRET_VALUE_GLOBS.map((glob) =>
    toCasePattern(glob, false),
  );
  return [
    `for __cn_name in $(awk 'BEGIN { for (k in ENVIRON) print k }' 2>/dev/null); do`,
    `  case $__cn_name in *[!A-Za-z0-9_]*|[0-9]*|__cn_*) continue ;; esac`,
    `  case $__cn_name in ${keepPatterns.join("|")}) continue ;; esac`,
    `  eval "__cn_value=\\\${$__cn_name-}"`,
    `  __cn_secret=`,
    `  case $__cn_name in ${namePatterns.join("|")}) __cn_secret=1 ;; esac`,
    `  case $__cn_value in ${valuePatterns.join("|")}) __cn_secret=1 ;; esac`,
    `  if [ -n "$__cn_secret" ]; then case $__cn_value in /*) if [ -f "$__cn_value" ]; then __cn_secret=; fi ;; esac; fi`,
    `  if [ -n "$__cn_secret" ]; then unset "$__cn_name" 2>/dev/null; fi`,
    `done`,
    `unset __cn_name __cn_value __cn_secret`,
  ].join("\n");
}

/**
 * PowerShell code that removes secret-like variables, run after the profile
 * and before the command: `-Command "<prelude>; <cmd>"`. `-like` is
 * case-insensitive like the name rules; values use the case-sensitive `-clike`.
 */
export function powershellUnsetPrelude(keep: readonly string[] = []): string {
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  const kept = [...keepSet(keep), ...KEPT_ENV_NAMES].map(quote).join(",");
  const tests = [
    ...SECRET_NAME_GLOBS.map((glob) => `($n -like ${quote(glob)})`),
    ...SECRET_VALUE_GLOBS.map((glob) => `($v -clike ${quote(glob)})`),
  ].join(" -or ");
  return (
    `Get-ChildItem Env: | ForEach-Object { ` +
    `$n = $_.Name; $v = $_.Value; ` +
    `if (@(${kept}) -contains $n.ToUpper()) { return }; ` +
    `$s = ${tests}; ` +
    `if ($s -and [IO.Path]::IsPathRooted($v) -and (Test-Path -LiteralPath $v -PathType Leaf)) { $s = $false }; ` +
    `if ($s) { Remove-Item -LiteralPath "Env:$n" } }`
  );
}
