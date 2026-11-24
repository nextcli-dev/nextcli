import { normalizeCommandName } from "./destructiveCommands.js";
import { extractSubstitutedCommands } from "./evaluateTerminalCommandSecurity.js";
import {
  hasBackgroundJob,
  hasDollarQuote,
  parseShellLine,
} from "./parseShell.js";

export interface SplitCommand {
  /**
   * Every simple command the line can run, as words. Each command appears as
   * written, and again for the command it runs behind a wrapper (`env`,
   * `timeout`, `sudo`, `xargs`...) and for each command inside `sh -c`,
   * `eval`, `find -exec`, a substitution or a subshell.
   */
  commands: string[][];
  /**
   * The line is one simple command: no second line, control operator,
   * redirect, substitution, subshell, or command run by `sh -c`, `eval` or
   * `find -exec`. `commands[0]` is that command as written.
   */
  single: boolean;
  /**
   * Part of what the line runs can't be read from it: a command named by a
   * variable or substitution (`$CMD`), inline code (`python -c`, `node -e`,
   * also glued to its flag: `python -c'...'`), a shell or interpreter
   * reading stdin (`curl x | sh`, `cat x | python3`), a shell given `-c` with
   * no command, or a line that doesn't parse. A script file (`bash deploy.sh`, `python x.py`, `source env.sh`)
   * is a command like any other: its contents are not read.
   */
  opaque: boolean;
  /**
   * A command runs inside another or behind syntax beyond a plain chain: a
   * substitution (`$()`, backticks, `<()`), a subshell, `sh -c`, `eval`,
   * `find -exec`, a background job (`&`), a heredoc, a group (`{ }`) or a
   * keyword (`if`, `for`, `while`...). Without these the line is a plain
   * chain: commands joined by `&&`, `||`, `;`, `|` and line breaks, with
   * redirects.
   */
  nested: boolean;
}

/** Words that start shell syntax rather than a simple command */
const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "coproc",
  "{",
  "}",
  "!",
  "[[",
]);

type Token = string | { op: string; pattern?: string } | { comment: string };

const MAX_DEPTH = 8;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/**
 * An interpreter runs code given on the line with one of its inline-code
 * flags (`python -c`), and code from stdin when it names no script
 */
interface Interpreter {
  name: RegExp;
  inlineCode: string[];
  /** Options that take the next word as a value (`python -W ignore`) */
  valueOptions: string[];
  /** Options that name what runs instead of a script (`python -m pytest`) */
  codeOptions: string[];
  /** Its scripts: after an option it doesn't list, a word that isn't one may be that option's value */
  scripts: RegExp;
}

const JS_SCRIPTS = /\.[cm]?[jt]sx?$/i;

const INTERPRETERS: Interpreter[] = [
  {
    name: /^python[\d.]*$/,
    inlineCode: ["-c"],
    valueOptions: ["-W", "-X", "-Q", "--check-hash-based-pycs"],
    codeOptions: ["-m"],
    scripts: /\.(py|pyw|pyz|pyc)$/i,
  },
  {
    // `bun install` and `bun x.ts` name what runs like a script does
    name: /^(node|nodejs|bun)$/,
    inlineCode: ["-e", "--eval", "-p", "--print"],
    valueOptions: [
      "-r",
      "--require",
      "--import",
      "-C",
      "--conditions",
      "--loader",
      "--experimental-loader",
      "--env-file",
      "--input-type",
    ],
    codeOptions: [],
    scripts: JS_SCRIPTS,
  },
  {
    name: /^deno$/,
    inlineCode: ["eval"],
    valueOptions: [],
    codeOptions: [],
    scripts: JS_SCRIPTS,
  },
  {
    name: /^ruby$/,
    inlineCode: ["-e"],
    valueOptions: ["-I", "-r", "-C", "-E", "-F"],
    codeOptions: [],
    scripts: /\.rb$/i,
  },
  {
    name: /^lua$/,
    inlineCode: ["-e"],
    valueOptions: ["-l"],
    codeOptions: [],
    scripts: /\.lua$/i,
  },
  {
    name: /^perl$/,
    inlineCode: ["-e", "-E"],
    valueOptions: ["-I", "-M", "-m"],
    codeOptions: [],
    scripts: /\.(pl|pm|t)$/i,
  },
  {
    name: /^php$/,
    inlineCode: ["-r"],
    valueOptions: ["-c", "-d", "-z"],
    // The built-in web server
    codeOptions: ["-S"],
    scripts: /\.(php|phar)$/i,
  },
  {
    name: /^osascript$/,
    inlineCode: ["-e"],
    valueOptions: ["-l", "-s"],
    codeOptions: [],
    scripts: /\.(scpt|applescript|js)$/i,
  },
  {
    name: /^(pwsh|powershell)$/,
    inlineCode: ["-c", "-command", "-Command"],
    valueOptions: [],
    codeOptions: [],
    scripts: /\.ps1$/i,
  },
];

interface WrapperGrammar {
  /** Short options that take a value: `-u name` or `-uname` */
  shortWithValue?: string;
  /** Long options that take a separate value: `--signal KILL` */
  longWithValue?: string[];
  /** Short options after which the command can't be read */
  opaqueShort?: string;
  /** Positional arguments before the command (timeout's duration) */
  positional?: number;
  /** `NAME=value` arguments before the command (env) */
  assignments?: boolean;
}

/** Commands that run the command after their own options */
const WRAPPERS: Record<string, WrapperGrammar> = {
  builtin: {},
  busybox: {},
  command: {},
  doas: { shortWithValue: "uC" },
  env: {
    shortWithValue: "uC",
    longWithValue: ["--unset", "--chdir"],
    opaqueShort: "S",
    assignments: true,
  },
  exec: { shortWithValue: "a" },
  ionice: { shortWithValue: "cnp" },
  nice: { shortWithValue: "n", longWithValue: ["--adjustment"] },
  nohup: {},
  stdbuf: {
    shortWithValue: "ioe",
    longWithValue: ["--input", "--output", "--error"],
  },
  sudo: {
    shortWithValue: "ugCDhprtTU",
    longWithValue: ["--user", "--group", "--chdir", "--host", "--prompt"],
  },
  time: { shortWithValue: "fo", longWithValue: ["--format", "--output"] },
  timeout: {
    shortWithValue: "sk",
    longWithValue: ["--signal", "--kill-after"],
    positional: 1,
  },
  watch: { shortWithValue: "n", longWithValue: ["--interval"] },
  xargs: {
    shortWithValue: "ILnPsEda",
    longWithValue: [
      "--max-args",
      "--max-procs",
      "--max-chars",
      "--delimiter",
      "--arg-file",
      "--eof",
      "--replace",
      "--max-lines",
    ],
  },
};

const VARIABLE_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Whether a command runs another one that splitCommand also lists: a wrapper
 * (`env`, `timeout`, `xargs`...) or a `NAME=value` prefix
 */
export function runsAnotherCommand(words: readonly string[]): boolean {
  return (
    words.length > 0 &&
    (VARIABLE_ASSIGNMENT.test(words[0]) ||
      Object.hasOwn(WRAPPERS, normalizeCommandName(words[0])))
  );
}

/**
 * Splits a shell command line into the simple commands it runs, so a rule
 * written for one command (`npm install*`) can be checked against each of
 * them. The result is a superset: it may list words that never run (a
 * heredoc body), but not miss a command it can see. What it can't see is
 * reported as `opaque`, except a script file named on the line (`bash
 * deploy.sh`, `python x.py`, `source env.sh`): that is an ordinary command,
 * and its contents are neither listed nor reported as `opaque`.
 */
export function splitCommand(command: string): SplitCommand {
  const state: State = {
    commands: [],
    single: true,
    opaque: false,
    nested: false,
    written: 0,
  };
  splitInto(command, state, 0);
  return {
    commands: state.commands,
    single: state.single && state.written === 1,
    opaque: state.opaque,
    nested: state.nested,
  };
}

interface State extends SplitCommand {
  /** Simple commands as written on the line itself */
  written: number;
}

function splitInto(command: string, result: State, depth: number) {
  if (depth > MAX_DEPTH) {
    result.opaque = true;
    return;
  }
  const lines = logicalLines(command)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length > 1) {
    result.single = false;
  }
  for (const line of lines) {
    splitLine(line, result, depth);
  }
}

/**
 * The lines bash runs: a backslash before a line break joins the lines,
 * except one that is escaped itself (`\\`) or inside a comment, which bash
 * leaves alone, so `git status # x \` and the next line are two commands.
 */
function logicalLines(command: string): string[] {
  const lines: string[] = [];
  let joined = "";
  for (const physical of command.split(/\r?\n|\r/)) {
    const line = joined + physical;
    const backslashes = /\\*$/.exec(line)![0].length;
    if (backslashes % 2 === 1 && !endsInComment(line)) {
      joined = line.slice(0, -1);
    } else {
      lines.push(line);
      joined = "";
    }
  }
  if (joined) {
    lines.push(joined);
  }
  return lines;
}

function endsInComment(line: string): boolean {
  try {
    const last = parseShellLine(line).at(-1);
    return typeof last === "object" && "comment" in last;
  } catch {
    return false;
  }
}

function splitLine(line: string, result: State, depth: number) {
  let tokens: Token[];
  try {
    // Keep variables as written, so `$CMD` is seen as a variable
    tokens = parseShellLine(line, (name) => `$${name}`) as Token[];
  } catch {
    result.opaque = true;
    return;
  }
  if (hasDollarQuote(line)) {
    result.opaque = true;
  }

  // Unquoted backticks are not tokens; read them from the text
  if (line.includes("`")) {
    result.single = false;
    result.nested = true;
    for (const inner of extractSubstitutedCommands(line)) {
      splitInto(inner, result, depth + 1);
    }
  }

  // What each `(` interrupted, resumed at its `)`: the outer command for
  // `$(`, `<(` and `>(`, or null for a subshell
  const suspended: Array<string[] | null> = [];
  let current: string[] = [];

  const finish = () => {
    if (current.length > 0) {
      result.written++;
      addSimpleCommand(current, result, depth);
    }
    current = [];
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (typeof token === "string") {
      // `$` before `(` starts a command substitution. Its place in the
      // outer command is kept as `$()`, so a substitution that names the
      // command (`$(which rm) -rf x`) is seen as a variable command.
      if (token === "$" && isOp(next, "(")) {
        result.single = false;
        result.nested = true;
        current.push("$()");
        suspended.push(current);
        current = [];
        i++;
        continue;
      }
      // A descriptor number before a redirect (`2>&1`) is not a word
      if (/^\d+$/.test(token) && isRedirect(next)) {
        continue;
      }
      current.push(token);
      continue;
    }
    if ("comment" in token) {
      continue;
    }
    if (token.op === "glob") {
      current.push(token.pattern ?? "");
      continue;
    }
    result.single = false;
    if (token.op === "<(" || (token.op === ">" && isOp(next, "("))) {
      result.nested = true;
      suspended.push(current);
      current = [];
      if (token.op === ">") i++;
      continue;
    }
    if (token.op === ")") {
      finish();
      current = suspended.pop() ?? [];
      continue;
    }
    if (isRedirectOp(token.op)) {
      // A heredoc's body is on the lines that follow, which are read as
      // commands too
      if (token.op === "<" && isOp(next, "<")) {
        result.nested = true;
      }
      // `<<` is two `<` and `>|` is `>` then `|`; the next word is the
      // file, delimiter or string
      while (isRedirect(tokens[i + 1]) || isOp(tokens[i + 1], "|")) i++;
      if (typeof tokens[i + 1] === "string") i++;
      continue;
    }
    // `&>` and `&>>` redirect both streams; the redirect is read next
    if (token.op === "&" && isRedirect(next) && !hasBackgroundJob(line)) {
      continue;
    }
    // Control operators and a subshell's `(`: the command ends here
    finish();
    if (token.op === "(") {
      result.nested = true;
      suspended.push(null);
    }
    if (token.op === "&") {
      result.nested = true;
    }
  }
  finish();
  while (suspended.length > 0) {
    current = suspended.pop() ?? [];
    finish();
  }
}

function addSimpleCommand(words: string[], result: State, depth: number) {
  result.commands.push(words);
  if (depth > 0 || SHELL_KEYWORDS.has(words[0])) {
    result.nested = true;
  }
  // Substitutions inside quoted words: echo "$(npm install)"
  for (const word of words) {
    if (word.includes("$(") || word.includes("`")) {
      result.single = false;
      result.nested = true;
      for (const inner of extractSubstitutedCommands(word)) {
        splitInto(inner, result, depth + 1);
      }
    }
  }

  let argv = words;
  for (let layer = 0; layer < MAX_DEPTH; layer++) {
    const start = argv.findIndex((word) => !VARIABLE_ASSIGNMENT.test(word));
    if (start === -1) {
      return;
    }
    if (start > 0) {
      argv = argv.slice(start);
    }
    if (argv[0].includes("$")) {
      result.opaque = true;
      return;
    }
    // Case and `.exe` don't change the program on Windows and macOS
    const name = normalizeCommandName(argv[0])
      .toLowerCase()
      .replace(/\.exe$/, "");
    const grammar = WRAPPERS[name];
    if (!grammar) {
      if (argv !== words) {
        result.commands.push(argv);
      }
      runsMore(name, argv, result, depth);
      return;
    }
    const unwrapped = stripWrapper(argv, grammar, result);
    if (unwrapped.length === 0) {
      return;
    }
    argv = unwrapped;
  }
  result.opaque = true;
}

/** Commands that run more commands: shells, eval, find -exec, inline code */
function runsMore(name: string, argv: string[], result: State, depth: number) {
  if (SHELLS.has(name)) {
    const run = shellRuns(argv);
    if (run.bodies.length > 0) {
      result.single = false;
      for (const body of run.bodies) {
        splitInto(body, result, depth + 1);
      }
    }
    if (run.opaque) {
      result.opaque = true;
    }
    return;
  }
  if (name === "eval") {
    result.single = false;
    splitInto(argv.slice(1).join(" "), result, depth + 1);
    return;
  }
  if (name === "find") {
    for (let i = 1; i < argv.length; i++) {
      if (/^-(exec|execdir|ok|okdir)$/.test(argv[i])) {
        const end = argv.findIndex(
          (word, j) => j > i && (word === ";" || word === "+"),
        );
        const inner = argv.slice(i + 1, end === -1 ? undefined : end);
        if (inner.length > 0) {
          result.single = false;
          addSimpleCommand(inner, result, depth + 1);
        }
      }
    }
    return;
  }
  const interpreter = INTERPRETERS.find((entry) => entry.name.test(name));
  if (
    interpreter &&
    (argv.slice(1).some((arg) => runsInlineCode(arg, interpreter.inlineCode)) ||
      readsCodeFromStdin(argv, interpreter))
  ) {
    result.opaque = true;
  }
}

/**
 * Whether an interpreter runs code from stdin: it names no script (`cat x |
 * python3`, `python <<EOF`) or names `-`. `python -m pytest` names a module,
 * which counts as a script. An option the interpreter's list doesn't know
 * may take the next word as its value (`node --max-http-header-size 80000`,
 * `ruby --encoding UTF-8`), so that word counts as the script only when it
 * looks like one.
 */
function readsCodeFromStdin(argv: string[], interpreter: Interpreter): boolean {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-") {
      return true;
    }
    if (arg === "--") {
      return i + 1 >= argv.length || argv[i + 1] === "-";
    }
    if (arg === "--version" || arg === "--help") {
      return false;
    }
    if (!arg.startsWith("-") || interpreter.codeOptions.includes(arg)) {
      return false;
    }
    const next = argv[i + 1];
    if (
      interpreter.valueOptions.includes(arg) ||
      (!arg.includes("=") &&
        next !== undefined &&
        !next.startsWith("-") &&
        !interpreter.scripts.test(next))
    ) {
      i++;
    }
  }
  return true;
}

/**
 * Whether an interpreter argument runs code given on the line: the flag
 * itself (`-c`), a short flag with the code glued on (`-c'import os'` is
 * one word, `-cimport os`) or ending a cluster (`-Ic`, `-ne`), or a long
 * flag with `=` (`--eval=...`).
 */
function runsInlineCode(arg: string, flags: string[]): boolean {
  return flags.some((flag) => {
    if (flag.startsWith("--")) {
      return arg === flag || arg.startsWith(`${flag}=`);
    }
    if (/^-[A-Za-z]$/.test(flag)) {
      return (
        arg.startsWith(flag) ||
        (/^-[A-Za-z]+$/.test(arg) && arg.endsWith(flag[1]))
      );
    }
    return arg === flag;
  });
}

/**
 * What a shell runs: the command string given with `-c` (`sh -lc 'cmd'`,
 * `bash -o pipefail -c 'cmd'`, or glued: `bash -c'cmd'` is the one word
 * `-ccmd`), stdin (`sh`, `bash -s`), or else the script file named after its
 * options. `opaque` when what runs can't be read: stdin, or `-c` with no
 * command. Any text after `c` in an option word is taken as a command too,
 * so a glued command is never missed; the superset is harmless.
 */
function shellRuns(argv: string[]): { bodies: string[]; opaque: boolean } {
  const bodies: string[] = [];
  let readsString = false;
  let readsStdin = false;
  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (/^[-+][oO]$/.test(arg)) {
      i += 2;
      continue;
    }
    if (arg.startsWith("--")) {
      i += arg === "--rcfile" || arg === "--init-file" ? 2 : 1;
      continue;
    }
    if (/^[-+]./.test(arg)) {
      const c = arg.startsWith("-") ? arg.indexOf("c") : -1;
      if (c !== -1) {
        readsString = true;
        if (c < arg.length - 1) {
          bodies.push(arg.slice(c + 1));
        }
      } else if (arg.startsWith("-") && arg.includes("s")) {
        readsStdin = true;
      }
      i++;
      continue;
    }
    break;
  }
  if (readsString) {
    if (i < argv.length) {
      bodies.push(argv[i]);
    }
    return { bodies, opaque: bodies.length === 0 };
  }
  // No script file named: the commands come from stdin (curl x | sh)
  return { bodies, opaque: readsStdin || i >= argv.length };
}

/** The command after a wrapper's options, or [] when it runs none */
function stripWrapper(
  argv: string[],
  grammar: WrapperGrammar,
  result: SplitCommand,
): string[] {
  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (arg.startsWith("--")) {
      const takesValue =
        !arg.includes("=") && grammar.longWithValue?.includes(arg);
      i += takesValue ? 2 : 1;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      i++;
      // A cluster such as -0I: the first option that takes a value ends it,
      // and reads the rest of the cluster or the next word
      for (let j = 1; j < arg.length; j++) {
        if (grammar.opaqueShort?.includes(arg[j])) {
          result.opaque = true;
          return [];
        }
        if (grammar.shortWithValue?.includes(arg[j])) {
          if (j === arg.length - 1) i++;
          break;
        }
      }
      continue;
    }
    break;
  }
  if (grammar.assignments) {
    while (i < argv.length && VARIABLE_ASSIGNMENT.test(argv[i])) i++;
  }
  i += grammar.positional ?? 0;
  return argv.slice(i);
}

function isOp(token: Token | undefined, op: string): boolean {
  return typeof token === "object" && "op" in token && token.op === op;
}

function isRedirectOp(op: string): boolean {
  return [">", ">>", ">&", "<", "<&", "<<<", ">|"].includes(op);
}

function isRedirect(token: Token | undefined): boolean {
  return typeof token === "object" && "op" in token && isRedirectOp(token.op);
}
