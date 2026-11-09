import { parse } from "shell-quote";

import { normalizeCommandName } from "./destructiveCommands.js";
import { extractSubstitutedCommands } from "./evaluateTerminalCommandSecurity.js";

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
   * variable or substitution (`$CMD`), inline code (`python -c`, `node -e`),
   * a shell reading stdin (`curl x | sh`), or a line that doesn't parse. A
   * script file (`bash deploy.sh`, `python x.py`, `source env.sh`) is a
   * command like any other.
   */
  opaque: boolean;
}

type Token = string | { op: string; pattern?: string } | { comment: string };

const MAX_DEPTH = 8;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** Interpreters and the flags that make them run code given on the line */
const INLINE_CODE_FLAGS: Array<[RegExp, string[]]> = [
  [/^python[\d.]*$/, ["-c"]],
  [/^(node|nodejs|bun)$/, ["-e", "--eval", "-p", "--print"]],
  [/^deno$/, ["eval"]],
  [/^(ruby|lua)$/, ["-e"]],
  [/^perl$/, ["-e", "-E"]],
  [/^php$/, ["-r"]],
  [/^osascript$/, ["-e"]],
  [/^(pwsh|powershell)$/, ["-c", "-command", "-Command"]],
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
 * Splits a shell command line into the simple commands it runs, so a rule
 * written for one command (`npm install*`) can be checked against each of
 * them. The result is a superset: it may list words that never run (a
 * heredoc body), but not miss a command it can see. What it can't see is
 * reported as `opaque`.
 */
export function splitCommand(command: string): SplitCommand {
  const state: State = {
    commands: [],
    single: true,
    opaque: false,
    written: 0,
  };
  splitInto(command, state, 0);
  return {
    commands: state.commands,
    single: state.single && state.written === 1,
    opaque: state.opaque,
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
  // A backslash before a line break joins the lines
  const lines = command
    .replace(/\\\r?\n/g, "")
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length > 1) {
    result.single = false;
  }
  for (const line of lines) {
    splitLine(line, result, depth);
  }
}

function splitLine(line: string, result: State, depth: number) {
  let tokens: Token[];
  try {
    // Keep variables as written, so `$CMD` is seen as a variable
    tokens = parse(line, (name) => `$${name}`) as Token[];
  } catch {
    result.opaque = true;
    return;
  }

  // Unquoted backticks are not tokens; read them from the text
  if (line.includes("`")) {
    result.single = false;
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
      // `<<` is two `<` and `>|` is `>` then `|`; the next word is the
      // file, delimiter or string
      while (isRedirect(tokens[i + 1]) || isOp(tokens[i + 1], "|")) i++;
      if (typeof tokens[i + 1] === "string") i++;
      continue;
    }
    // Control operators and a subshell's `(`: the command ends here
    finish();
    if (token.op === "(") {
      suspended.push(null);
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
  // Substitutions inside quoted words: echo "$(npm install)"
  for (const word of words) {
    if (word.includes("$(") || word.includes("`")) {
      result.single = false;
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
    const name = normalizeCommandName(argv[0]);
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
    if (run.body !== undefined) {
      result.single = false;
      splitInto(run.body, result, depth + 1);
    } else if (run.stdin) {
      // curl x | sh: the commands come from stdin
      result.opaque = true;
    }
    // Otherwise a script file, named on the line: bash deploy.sh
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
  for (const [pattern, flags] of INLINE_CODE_FLAGS) {
    if (
      pattern.test(name) &&
      argv.slice(1).some((arg) => flags.includes(arg))
    ) {
      result.opaque = true;
      return;
    }
  }
}

/**
 * What a shell runs: the command string given with `-c` (`sh -lc 'cmd'`,
 * `bash -o pipefail -c 'cmd'`), stdin (`sh`, `bash -s`), or else the script
 * file named after its options.
 */
function shellRuns(argv: string[]): { body?: string; stdin: boolean } {
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
      if (arg.startsWith("-") && arg.includes("c")) {
        readsString = true;
      } else if (arg.startsWith("-") && arg.includes("s")) {
        readsStdin = true;
      }
      i++;
      continue;
    }
    break;
  }
  if (readsString) {
    return { body: argv[i], stdin: false };
  }
  return { stdin: readsStdin || i >= argv.length };
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
