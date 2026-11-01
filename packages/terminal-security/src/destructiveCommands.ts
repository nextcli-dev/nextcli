import * as path from "node:path";

import { parse } from "shell-quote";

/**
 * How dangerous a command's deletions or disk writes are:
 * - "catastrophic": destroys the system, a home directory or a disk. Always
 *   disabled; a person can't approve it either.
 * - "destructive": deletes something broad (a top-level directory, a path the
 *   checker can't resolve statically, a `..` escape). Needs a person: the CLI
 *   prompts interactively and refuses in headless mode.
 */
export type DestructiveRisk = "catastrophic" | "destructive";

const RISK_ORDER: Record<DestructiveRisk, number> = {
  destructive: 1,
  catastrophic: 2,
};

// Recursion limit for `sh -c`, wrappers and substitutions
const MAX_DEPTH = 5;

// Virtual home directory, so `~`, `$HOME` and `/Users/<name>` normalize alike
const HOME_ROOT = "/__home__";
const HOME_VARIABLES = ["HOME", "USERPROFILE"];

const SYSTEM_ROOTS = [
  "usr",
  "etc",
  "bin",
  "sbin",
  "boot",
  "lib",
  "lib32",
  "lib64",
  "system",
];

const SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"];

// Wrappers run their remaining arguments as a command. The values list the
// options that take a separate argument, so the walk doesn't stop on them.
const WRAPPER_OPTIONS: Record<string, string[]> = {
  xargs: [
    "-I",
    "-L",
    "-n",
    "-P",
    "-s",
    "-d",
    "-E",
    "-a",
    "--max-args",
    "--max-procs",
    "--max-lines",
    "--delimiter",
    "--arg-file",
    "--replace",
  ],
  env: ["-u", "--unset", "-C", "--chdir"],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "-n", "-p"],
  nohup: [],
  command: [],
  builtin: [],
  time: ["-f", "-o"],
  stdbuf: [],
  timeout: ["-s", "--signal", "-k", "--kill-after"],
  busybox: [],
  toybox: [],
};

const NARROWING_FIND_TESTS = [
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-wholename",
  "-iwholename",
  "-regex",
  "-iregex",
];
const MATCH_ALL_PATTERNS = ["*", "**", ".*", ".+", "^.*$"];
const FIND_OR_OPERATORS = ["-o", "-or", ",", "!", "-not"];
const FIND_EXEC_ACTIONS = ["-exec", "-execdir", "-ok", "-okdir"];
const FILE_DELETE_COMMANDS = ["rm", "unlink", "shred"];

// A partitioning command is read-only only when every argument is a device,
// a number or one of these flags, and at least one of these flags is present
const READ_ONLY_PARTITION_ARGS: Record<string, string[]> = {
  fdisk: ["-l", "--list", "-x", "--list-details"],
  sfdisk: ["-l", "--list", "-d", "--dump", "-J", "--json", "-V", "--verify"],
  cfdisk: [],
  gdisk: ["-l"],
  sgdisk: ["-p", "--print", "-v", "--verify", "-i", "--info", "-O"],
  parted: ["-l", "--list", "-s", "--script", "-m", "--machine", "print"],
};

const WINDOWS_DELETE_COMMANDS = [
  "remove-item",
  "ri",
  "rd",
  "rmdir",
  "del",
  "erase",
  "rm",
];

interface ShellOperator {
  op: string;
}

interface GlobPattern {
  op: "glob";
  pattern: string;
}

type ParsedToken = string | ShellOperator | GlobPattern | { comment: string };

function maxRisk(...risks: (DestructiveRisk | null)[]): DestructiveRisk | null {
  let result: DestructiveRisk | null = null;
  for (const risk of risks) {
    if (risk && (!result || RISK_ORDER[risk] > RISK_ORDER[result])) {
      result = risk;
    }
  }
  return result;
}

/**
 * Classifies the deletions and disk writes in a shell command
 */
export function classifyDestructiveCommand(
  command: string,
  depth = 0,
): DestructiveRisk | null {
  if (!command) return null;
  // Nesting this deep is itself suspicious; don't let it hide a delete
  if (depth > MAX_DEPTH) return "destructive";

  let risk: DestructiveRisk | null = null;
  for (const line of command.split(/\r?\n|\r/)) {
    if (line.trim() === "") continue;
    risk = maxRisk(risk, classifyLine(line, depth));
    if (risk === "catastrophic") return risk;
  }
  return risk;
}

/**
 * True when a command needs a person to approve it: it deletes or wipes
 * something broad, or something the checker can't resolve statically
 */
export function isDestructiveTerminalCommand(
  command: string | null | undefined,
): boolean {
  return !!command && classifyDestructiveCommand(command) !== null;
}

function classifyLine(line: string, depth: number): DestructiveRisk | null {
  let risk: DestructiveRisk | null = null;

  // shell-quote splits backtick substitutions into loose tokens
  for (const match of line.matchAll(/`([^`]*)`/g)) {
    risk = maxRisk(risk, classifyDestructiveCommand(match[1], depth + 1));
  }

  let tokens: ParsedToken[];
  try {
    // Keep variables as `${NAME}` instead of expanding them to ""
    tokens = parse(line, (key) => `\${${key}}`) as ParsedToken[];
  } catch {
    return maxRisk(risk, "destructive");
  }

  // Shell operators (`&&`, `|`, `;`, `(`, `>`) separate commands
  let current: string[] = [];
  const segments: string[][] = [];
  for (const token of tokens) {
    if (typeof token === "string") {
      current.push(token);
    } else if ("op" in token && token.op === "glob") {
      current.push((token as GlobPattern).pattern);
    } else if ("op" in token) {
      if (current.length > 0) segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);

  for (const segment of segments) {
    risk = maxRisk(risk, classifySegment(segment, depth));
  }

  // Windows paths need their backslashes, which shell-quote removes
  for (const segment of splitRawSegments(line)) {
    risk = maxRisk(risk, classifyWindowsDelete(segment));
  }

  return risk;
}

/**
 * Strips a path prefix from a command name, so `/bin/rm` is treated as `rm`
 */
export function normalizeCommandName(command: string): string {
  const name = command.replace(/^\\/, "");
  return name.includes("/") && !name.endsWith("/")
    ? name.slice(name.lastIndexOf("/") + 1)
    : name;
}

function classifySegment(
  tokens: string[],
  depth: number,
): DestructiveRisk | null {
  // Skip leading variable assignments (`FOO=1 rm -rf /`)
  let start = 0;
  while (
    start < tokens.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])
  ) {
    start++;
  }
  if (start >= tokens.length) return null;

  const command = normalizeCommandName(tokens[start].toLowerCase());
  const args = tokens.slice(start + 1);

  if (command in WRAPPER_OPTIONS) {
    return classifyWrapper(command, args, depth);
  }
  if (SHELLS.includes(command)) {
    const script = getShellScript(args);
    return script === undefined
      ? null
      : classifyDestructiveCommand(script, depth + 1);
  }
  if (command === "powershell" || command === "pwsh") {
    return classifyPowerShell(args, depth);
  }
  if (command === "cmd") {
    const idx = args.findIndex((arg) => /^\/[ck]$/i.test(arg));
    return idx === -1
      ? null
      : classifyDestructiveCommand(args.slice(idx + 1).join(" "), depth + 1);
  }

  // `rm` hidden in a variable is treated as rm
  if (command === "rm" || command.startsWith("$")) {
    return classifyRecursiveDelete(args);
  }

  switch (command) {
    case "find":
      return classifyFind(args);
    case "ln":
      return classifySymlink(args);
    case "wipefs":
      return classifyWipefs(args);
    case "shred":
      return classifyShred(args);
    case "truncate":
      return classifyTruncate(args);
    case "diskutil":
      return classifyDiskutil(args);
    default:
      if (command in READ_ONLY_PARTITION_ARGS) {
        return classifyPartitionTool(command, args);
      }
      return null;
  }
}

function classifyWrapper(
  command: string,
  args: string[],
  depth: number,
): DestructiveRisk | null {
  const takesValue = WRAPPER_OPTIONS[command];
  let idx = 0;
  while (idx < args.length) {
    const arg = args[idx];
    if (arg === "--") {
      idx++;
      break;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      idx += takesValue.includes(arg) ? 2 : 1;
      continue;
    }
    if (command === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      idx++;
      continue;
    }
    break;
  }
  // timeout's first operand is the duration
  if (command === "timeout") idx++;

  const wrapped = args.slice(idx);
  if (wrapped.length === 0) return null;

  const risk = classifySegment(wrapped, depth + 1);

  // xargs supplies the targets from stdin, which can't be checked statically
  if (command === "xargs") {
    const wrappedCommand = normalizeCommandName(wrapped[0].toLowerCase());
    const wrappedArgs = wrapped.slice(1);
    const deletes =
      (wrappedCommand === "rm" && wrappedArgs.some(isRecursiveFlag)) ||
      wrappedCommand === "shred";
    if (deletes) {
      return maxRisk(risk, "destructive");
    }
  }

  return risk;
}

/**
 * Returns the script of `sh -c '<script>'`, including clusters like `-lc`
 */
function getShellScript(args: string[]): string | undefined {
  const idx = args.findIndex(
    (arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg) || arg === "--command",
  );
  return idx === -1 ? undefined : args[idx + 1];
}

function classifyPowerShell(
  args: string[],
  depth: number,
): DestructiveRisk | null {
  const idx = args.findIndex((arg) => /^-(c|command)$/i.test(arg));
  if (idx !== -1) {
    return classifyDestructiveCommand(args.slice(idx + 1).join(" "), depth + 1);
  }
  // An encoded command can't be inspected
  if (args.some((arg) => /^-(e|ec|encodedcommand)$/i.test(arg))) {
    return "destructive";
  }
  return null;
}

/**
 * Checks if an argument is a recursive flag, in any case or combination
 * (`-r`, `-R`, `-Rf`, `-fR`, `--recursive`, PowerShell `-Recurse`)
 */
function isRecursiveFlag(arg: string): boolean {
  const lower = arg.toLowerCase();
  return (
    lower === "--recursive" ||
    lower === "-recurse" ||
    (/^-[a-z]+$/.test(lower) && lower.includes("r"))
  );
}

/**
 * Returns the operands of a command: everything that isn't an option, and
 * everything after `--`
 */
function getOperands(args: string[]): string[] {
  const separator = args.indexOf("--");
  const options = separator === -1 ? args : args.slice(0, separator);
  const rest = separator === -1 ? [] : args.slice(separator + 1);
  return [...options.filter((arg) => !arg.startsWith("-")), ...rest];
}

function classifyRecursiveDelete(args: string[]): DestructiveRisk | null {
  if (!args.some(isRecursiveFlag)) return null;
  return maxRisk(...getOperands(args).map(classifyTarget));
}

/**
 * Checks if `find` deletes under its roots without a test that narrows what
 * is deleted. Tests only narrow when they come before the delete action and
 * nothing in the expression is an OR or a negation.
 */
function classifyFind(args: string[]): DestructiveRisk | null {
  const firstExpression = args.findIndex(
    (arg) => arg.startsWith("-") || ["(", ")", "!", ","].includes(arg),
  );
  const roots = firstExpression === -1 ? args : args.slice(0, firstExpression);
  const expression = firstExpression === -1 ? [] : args.slice(firstExpression);

  const deleteIdx = expression.findIndex(
    (arg, idx) =>
      arg === "-delete" ||
      (FIND_EXEC_ACTIONS.includes(arg) &&
        idx < expression.length - 1 &&
        FILE_DELETE_COMMANDS.includes(
          normalizeCommandName(expression[idx + 1].toLowerCase()),
        )),
  );
  if (deleteIdx === -1) return null;

  const hasOr = expression.some((arg) => FIND_OR_OPERATORS.includes(arg));
  const narrowed =
    !hasOr &&
    expression
      .slice(0, deleteIdx)
      .some(
        (arg, idx, before) =>
          NARROWING_FIND_TESTS.includes(arg) &&
          !MATCH_ALL_PATTERNS.includes(before[idx + 1] ?? "*"),
      );
  if (narrowed) return null;

  return maxRisk(...(roots.length > 0 ? roots : ["."]).map(classifyTarget));
}

/**
 * A symlink to a broad directory lets a later `rm -rf link/` delete it
 */
function classifySymlink(args: string[]): DestructiveRisk | null {
  const symbolic = args.some(
    (arg) => arg === "--symbolic" || /^-[a-zA-Z]*s[a-zA-Z]*$/.test(arg),
  );
  if (!symbolic) return null;
  const [source] = getOperands(args);
  return source !== undefined && isBroadDirectory(source)
    ? "destructive"
    : null;
}

function classifyWipefs(args: string[]): DestructiveRisk | null {
  const hasShortFlag = (flag: string) =>
    args.some((arg) => new RegExp(`^-[a-zA-Z]*${flag}[a-zA-Z]*$`).test(arg));
  const erases =
    hasShortFlag("a") ||
    hasShortFlag("o") ||
    args.includes("--all") ||
    args.some((arg) => arg.startsWith("--offset"));
  const dryRun = hasShortFlag("n") || args.includes("--no-act");
  return erases && !dryRun ? "catastrophic" : null;
}

function targetsSystem(args: string[]): boolean {
  return getOperands(args).some(
    (arg) => arg.startsWith("/dev/") || classifyTarget(arg) === "catastrophic",
  );
}

function classifyShred(args: string[]): DestructiveRisk | null {
  return targetsSystem(args) ? "catastrophic" : null;
}

function classifyTruncate(args: string[]): DestructiveRisk | null {
  // Zero (`0`, `0B`, `0K`) or a shrinking size (`-10`, `<5`, `/2`)
  const shrinks = (size: string | undefined) =>
    size !== undefined && /^(0+[a-z]*|[-<\/].*)$/i.test(size);
  const sizeArgs: string[] = [];
  const shrinksToZero = args.some((arg, idx) => {
    if (arg === "-s" || arg === "--size") {
      sizeArgs.push(args[idx + 1]);
      return shrinks(args[idx + 1]);
    }
    if (arg.startsWith("--size=")) return shrinks(arg.slice(7));
    if (/^-s./.test(arg)) return shrinks(arg.slice(2));
    return false;
  });
  const targets = args.filter((arg) => !sizeArgs.includes(arg));
  return shrinksToZero && targetsSystem(targets) ? "catastrophic" : null;
}

function classifyDiskutil(args: string[]): DestructiveRisk | null {
  const [verb = "", subVerb = ""] = args.map((arg) => arg.toLowerCase());
  const erases =
    verb.startsWith("erase") ||
    [
      "zerodisk",
      "randomdisk",
      "secureerase",
      "partitiondisk",
      "reformat",
    ].includes(verb) ||
    (verb === "apfs" && /^(delete|erase)/.test(subVerb));
  return erases ? "catastrophic" : null;
}

function classifyPartitionTool(
  command: string,
  args: string[],
): DestructiveRisk | null {
  const readOnlyArgs = READ_ONLY_PARTITION_ARGS[command];
  const hasReadOnlyFlag = args.some((arg) => readOnlyArgs.includes(arg));
  const onlyReads = args.every(
    (arg) =>
      readOnlyArgs.includes(arg) ||
      arg.startsWith("/dev/") ||
      /^\d+$/.test(arg),
  );
  return hasReadOnlyFlag && onlyReads ? null : "catastrophic";
}

/**
 * Classifies one path a command deletes or overwrites
 */
export function classifyTarget(arg: string): DestructiveRisk | null {
  if (!arg) return null;
  // A substitution's output can't be known. shell-quote turns `$(pwd)` into
  // an empty variable "${}" followed by the "(" operator.
  if (arg.includes("`") || arg.includes("$(") || arg.includes("${}")) {
    return "destructive";
  }

  if (looksLikeWindowsPath(arg)) {
    return classifyWindowsTarget(arg);
  }

  const variable = arg.match(
    /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*))(.*)$/,
  );
  if (variable) {
    const name = (variable[1] ?? variable[3]).toUpperCase();
    const modifier = variable[2] ?? "";
    const rest = variable[4];
    const isHome = HOME_VARIABLES.includes(name);

    if (modifier) {
      // `${X:-word}`, `${X:=word}`, `${X:+word}`: the word may be used
      const word = modifier.match(/^:?[-=+?](.*)$/)?.[1];
      return maxRisk(
        "destructive",
        word !== undefined ? classifyTarget(word + rest) : null,
        isHome ? classifyPosixTarget(HOME_ROOT + rest) : null,
      );
    }
    if (isHome) {
      return classifyPosixTarget(HOME_ROOT + rest);
    }
    // An unknown variable is fine with a subdirectory after it, but not
    // alone or climbing above itself
    const resolved = path.posix.normalize(`/__var__${rest}`);
    return resolved.startsWith("/__var__/") ? null : "destructive";
  }

  if (arg === "~" || arg.startsWith("~/")) {
    return classifyPosixTarget(HOME_ROOT + arg.slice(1));
  }
  const otherHome = arg.match(/^~([^/]+)(.*)$/);
  if (otherHome) {
    return classifyPosixTarget(`/home/${otherHome[1]}${otherHome[2]}`);
  }

  return classifyPosixTarget(arg);
}

/**
 * True for a directory whose removal would be broad: a root, a top-level
 * directory, a home directory, or a path that can't be resolved statically
 */
function isBroadDirectory(arg: string): boolean {
  const risk = classifyTarget(arg);
  if (risk === null) return false;
  if (risk === "destructive") return true;
  // Catastrophic paths include files deep under /usr; only roots count here
  const normalized = arg.startsWith("/")
    ? path.posix.normalize(arg).replace(/\/+$/, "")
    : "";
  return normalized.split("/").filter(Boolean).length <= 2;
}

function classifyPosixTarget(target: string): DestructiveRisk | null {
  if (!target.startsWith("/")) {
    // A relative path that is the working directory or climbs above it
    const normalized = path.posix.normalize(target).replace(/\/+$/, "");
    return normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../")
      ? "destructive"
      : null;
  }

  let normalized = path.posix
    .normalize(target)
    .toLowerCase()
    // `/tmp/*` deletes everything in /tmp
    .replace(/(\/\*|\/\.\*)+$/, "")
    .replace(/\/+$/, "")
    // macOS aliases: /private/tmp is /tmp, the data volume is /
    .replace(/^\/system\/volumes\/data(?=\/|$)/, "")
    .replace(/^\/private(?=\/(tmp|var|etc)(\/|$))/, "");

  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return "catastrophic";

  const [top] = parts;
  if (top === HOME_ROOT.slice(1)) {
    return parts.length === 1
      ? "catastrophic"
      : parts.length === 2
        ? "destructive"
        : null;
  }
  if (top === "home" || top === "users") {
    return parts.length <= 2
      ? "catastrophic"
      : parts.length === 3
        ? "destructive"
        : null;
  }
  if (top === "root") {
    return parts.length === 1
      ? "catastrophic"
      : parts.length === 2
        ? "destructive"
        : null;
  }
  if (SYSTEM_ROOTS.includes(top)) return "catastrophic";
  if (parts.length === 1) return "destructive";
  return null;
}

function looksLikeWindowsPath(arg: string): boolean {
  return (
    /^[a-z]:/i.test(arg) ||
    arg.includes("\\") ||
    /^%\w+%/.test(arg) ||
    /^\$env:/i.test(arg)
  );
}

function classifyWindowsTarget(arg: string): DestructiveRisk | null {
  let target = arg
    .replace(
      /^(%userprofile%|\$env:userprofile|\$home)(?=[\\/]|$)/i,
      "C:\\Users\\__home__",
    )
    .replace(
      /^(%systemroot%|%windir%|\$env:systemroot|\$env:windir)/i,
      "C:\\Windows",
    );

  // Any other variable: fine with a subdirectory after it, not alone
  const variable = target.match(/^(%\w+%|\$env:\w+)(.*)$/i);
  if (variable) {
    const rest = variable[2]
      .split(/[\\/]/)
      .filter((part) => part && part !== ".");
    return rest.length > 0 && !rest.includes("..") ? null : "destructive";
  }

  // shell-quote turns `C:\Users` into `C:Users`
  if (/^[a-z]:(?![\\/])/i.test(target)) {
    target = `${target.slice(0, 2)}\\${target.slice(2)}`;
  }

  const normalized = path.win32
    .normalize(target)
    .toLowerCase()
    .replace(/([\\/]+(\*|\.)?)+$/, "");
  const drive = normalized.match(/^([a-z]):(.*)$/);
  if (!drive) {
    const relative = normalized.replace(/\\/g, "/");
    return relative === "" ||
      relative === "." ||
      relative === ".." ||
      relative.startsWith("../")
      ? "destructive"
      : null;
  }

  const parts = drive[2].split(/[\\/]/).filter((part) => part && part !== ".");
  if (parts.length === 0) return "catastrophic";

  const [top] = parts;
  if (
    top === "windows" ||
    top === "programdata" ||
    top.startsWith("program files")
  ) {
    return "catastrophic";
  }
  if (top === "users") {
    return parts.length <= 2
      ? "catastrophic"
      : parts.length === 3
        ? "destructive"
        : null;
  }
  if (parts.length === 1) return "destructive";
  return null;
}

/**
 * Splits a command line on shell separators outside quotes, keeping
 * backslashes, for Windows commands
 */
function splitRawSegments(line: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: string | null = null;

  const endToken = () => {
    if (hasToken) tokens.push(current);
    current = "";
    hasToken = false;
  };

  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      endToken();
    } else if (char === ";" || char === "|" || char === "&") {
      endToken();
      if (tokens.length > 0) segments.push(tokens);
      tokens = [];
    } else {
      current += char;
      hasToken = true;
    }
  }
  endToken();
  if (tokens.length > 0) segments.push(tokens);
  return segments;
}

function classifyWindowsDelete(tokens: string[]): DestructiveRisk | null {
  const command = tokens[0]?.toLowerCase() ?? "";
  if (!WINDOWS_DELETE_COMMANDS.includes(command)) return null;

  const args = tokens.slice(1);
  const recursive = args.some(
    (arg) =>
      /^-r(e(c(u(r(se?)?)?)?)?)?$/i.test(arg) ||
      arg.toLowerCase() === "/s" ||
      isRecursiveFlag(arg),
  );
  if (!recursive) return null;

  const targets = args.filter(
    (arg) => !arg.startsWith("-") && !/^\/[a-z?]$/i.test(arg),
  );
  return maxRisk(
    ...targets.filter(looksLikeWindowsPath).map(classifyWindowsTarget),
  );
}
