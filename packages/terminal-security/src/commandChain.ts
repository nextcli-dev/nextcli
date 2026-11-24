import fs from "node:fs";
import path from "node:path";

import { quote } from "shell-quote";

import { normalizeCommandName } from "./destructiveCommands.js";
import {
  evaluateLineStructure,
  evaluateTerminalCommandSecurity,
  isGitInternalPath,
} from "./evaluateTerminalCommandSecurity.js";
import { runsAnotherCommand, splitCommand } from "./splitCommand.js";
import { ToolPolicy } from "./types.js";

/** `*` matches any characters (newlines too), `?` one character */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
    "s",
  );
}

/**
 * Whether an allow rule, the inside of `Bash(...)`, covers one command: the
 * command's words joined by spaces match the glob, as written
 */
export function commandMatchesAllowRule(
  words: readonly string[],
  rule: string,
): boolean {
  return words.length > 0 && globToRegExp(rule).test(words.join(" "));
}

/**
 * Whether an exclude or ask written as `Bash(glob)` covers one command. It
 * errs toward matching: the command name is compared without its directory
 * (`/usr/bin/npm`), and the glob's other words need only appear in order, so
 * `npm install*` covers `npm -g install x` and `npm --prefix /tmp install x`.
 * An argument with an unexpanded `$` could be anything, so it matches any
 * word. A rule that names a concrete command (`npm install*`) doesn't match
 * a command named by a variable (`$CMD`); `Bash(*)` and a rule that spells
 * the variable out (`Bash($CMD*)`) do.
 */
export function commandMatchesDenyRule(
  words: readonly string[],
  glob: string,
): boolean {
  if (words.length === 0) {
    return false;
  }
  const argv = [normalizeCommandName(words[0]), ...words.slice(1)];
  if (globToRegExp(glob).test(argv.join(" "))) {
    return true;
  }
  const [name, ...rest] = glob.trim().split(/\s+/);
  if (!globToRegExp(normalizeCommandName(name)).test(argv[0])) {
    return false;
  }
  const argumentMatches = (word: string, part: string) =>
    word.includes("$") || globToRegExp(part).test(word);
  let next = 1;
  for (const part of rest) {
    while (next < argv.length && !argumentMatches(argv[next], part)) {
      next++;
    }
    if (next === argv.length) {
      return false;
    }
    next++;
  }
  return true;
}

/**
 * The allow rule that remembers one command, or undefined when it can't be
 * written as one. The command and its subcommand are kept (`npm test` →
 * `npm test*`), or the whole command when the first argument is an option
 * (`ls -la` → `ls -la`), so `npm test` never approves `npm install`.
 */
export function ruleForCommand(words: readonly string[]): string | undefined {
  if (words.length === 0) {
    return undefined;
  }
  const prefix = words.length > 1 && !words[1].startsWith("-");
  const kept = prefix ? words.slice(0, 2) : words;
  // A word with a glob character, a parenthesis or a space can't be written
  // back as the same rule
  if (kept.some((word) => word === "" || /[*?()\s]/.test(word))) {
    return undefined;
  }
  const rule = kept.join(" ");
  return prefix ? `${rule}*` : rule;
}

/**
 * Whether a rule typed into a trusted-command list can be used: it starts
 * with a command name rather than a glob character (`git commit*` and `git*`,
 * not `*` or `?it`), and has no parenthesis, line break or surrounding space
 */
export function isValidCommandRule(rule: string): boolean {
  return (
    rule.trim() === rule && /^[^\s*?]/.test(rule) && !/[()\r\n]/.test(rule)
  );
}

/** One command of a plain chain */
export interface ChainCommand {
  /** The command's words, as splitCommand reads them */
  words: string[];
  /** The command as a line the evaluator reads the same way */
  text: string;
}

/** Commands that change the shell for the commands after them */
const SHELL_STATE_COMMANDS = new Set([
  "export",
  "declare",
  "typeset",
  "local",
  "readonly",
  "set",
  "unset",
  "alias",
  "unalias",
  "source",
  ".",
  "exec",
  "trap",
  "umask",
  "ulimit",
  "shopt",
  "hash",
  "enable",
  "popd",
  "read",
  "mapfile",
  "readarray",
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Whether `cd dir` or `pushd dir` names an existing path inside `cwd` and
 * outside `.git` (a file makes `cd` fail, which leaves the shell in `cwd`),
 * read the way the shell will: symlinks followed, and a relative name taken
 * from `cwd` (the shell runs without CDPATH, see secureShellCommand). A name
 * the shell would expand (`~`, `$`, a glob or a
 * brace), a stack entry (`-`, `+1`) and `..` (which `cd` reads before
 * symlinks, and `cd -P` after) don't qualify.
 */
function entersSubdirectory(args: readonly string[], cwd: string): boolean {
  const operands = args.filter((word) => word === "-" || !word.startsWith("-"));
  const dir = operands[0];
  if (
    operands.length !== 1 ||
    dir === "" ||
    /^[-+~]|[$*?[{]/.test(dir) ||
    dir.split(/[\\/]/).includes("..")
  ) {
    return false;
  }
  try {
    const root = fs.realpathSync(cwd);
    const target = fs.realpathSync(path.resolve(root, dir));
    const relative = path.relative(root, target);
    return (
      !path.isAbsolute(relative) &&
      relative.split(path.sep)[0] !== ".." &&
      !isGitInternalPath(relative)
    );
  } catch {
    return false;
  }
}

/**
 * Whether a command changes what the commands after it do: an assignment on
 * its own, `export`, `source`, `alias`..., or a `cd` or `pushd` other than
 * into a subdirectory at the start of the line (`cd .. && git push` pushes
 * another repository). Later in the line, an earlier command could have made
 * the directory a symlink. Without `cwd`, every `cd` counts.
 */
function changesShellState(
  words: readonly string[],
  index: number,
  cwd: string | undefined,
): boolean {
  if (words.every((word) => ASSIGNMENT.test(word))) {
    return true;
  }
  const name = normalizeCommandName(words[0]);
  if (SHELL_STATE_COMMANDS.has(name)) {
    return true;
  }
  if (name === "cd" || name === "pushd") {
    return index > 0 || !cwd || !entersSubdirectory(words.slice(1), cwd);
  }
  return false;
}

/**
 * The command as a line: quoted so it parses back to the same words, except
 * that a word with `$` is double-quoted, so the evaluator still sees it
 * expand
 */
function commandText(words: readonly string[]): string {
  return words
    .map((word) =>
      word.includes("$")
        ? `"${word.replace(/["\\`]/g, "\\$&")}"`
        : quote([word]),
    )
    .join(" ");
}

/**
 * The commands of a plain chain, or undefined when the line isn't one. A
 * plain chain joins simple commands with `&&`, `||`, `;`, `|` and line
 * breaks, with redirects, and nothing else (see SplitCommand.nested). Every
 * command splitCommand lists is included, so a wrapper (`timeout 60 npm
 * test`) is there both as written and as the command it runs. A command that
 * changes the shell for later commands (`export`, `source`, `cd ..`) makes a
 * line of several commands ineligible; see changesShellState for `cd`.
 */
export function chainCommands(
  line: string,
  options?: ChainOptions,
): ChainCommand[] | undefined {
  const split = splitCommand(line);
  if (split.opaque || split.nested || split.commands.length === 0) {
    return undefined;
  }
  if (
    !split.single &&
    split.commands.some((words, index) =>
      changesShellState(words, index, options?.cwd),
    )
  ) {
    return undefined;
  }
  return split.commands.map((words) => ({ words, text: commandText(words) }));
}

export interface ChainOptions {
  /**
   * The directory the line runs in. With it, a line may start with a `cd`
   * or `pushd` into one of its subdirectories (`cd sub && npm test`).
   */
  cwd?: string;
}

/**
 * Whether a line runs without asking because each of its commands would on
 * its own: it is a plain chain (chainCommands), what joins the commands is
 * safe (no catastrophic or destructive command, no redirect that writes a
 * file, no pipe into an interpreter or a network tool, no substitution or
 * obfuscation; see evaluateLineStructure), and `isAllowed` allows every
 * command. A single command is a chain of one.
 */
export function allowsCommandChain(
  line: string,
  isAllowed: (command: ChainCommand) => boolean,
  options?: ChainOptions,
): boolean {
  const commands = chainCommands(line, options);
  return (
    !!commands &&
    evaluateLineStructure(line) === "allowedWithoutPermission" &&
    commands.every(isAllowed)
  );
}

/**
 * The allow rules that let this line run without asking next time, one per
 * command `isAllowed` doesn't allow yet, or undefined when nothing may be
 * remembered: the line isn't a plain chain or fails the structure check
 * (see allowsCommandChain), a command is a wrapper or has a `NAME=value`
 * prefix, or a command can't be written as a rule (see ruleForCommand).
 */
export function rulesToRemember(
  line: string,
  isAllowed: (command: ChainCommand) => boolean,
  options?: ChainOptions,
): string[] | undefined {
  const commands = chainCommands(line, options);
  if (
    !commands ||
    commands.some((command) => runsAnotherCommand(command.words))
  ) {
    return undefined;
  }
  const rules: string[] = [];
  for (const command of commands) {
    if (isAllowed(command)) {
      continue;
    }
    const rule = ruleForCommand(command.words);
    if (!rule) {
      return undefined;
    }
    if (!rules.includes(rule)) {
      rules.push(rule);
    }
  }
  const covered = allowsCommandChain(
    line,
    (command) =>
      isAllowed(command) ||
      rules.some((rule) => commandMatchesAllowRule(command.words, rule)),
    options,
  );
  return rules.length > 0 && covered ? rules : undefined;
}

/**
 * The extension's check for a command the user trusts: under the tool's
 * policy, each command of the line matches a trusted rule or is approved by
 * the evaluator on its own, and the line passes allowsCommandChain. A tool
 * the user excluded stays excluded.
 */
export function isTrustedTerminalCommand(
  line: string,
  trustedRules: readonly string[],
  basePolicy: ToolPolicy,
  options?: ChainOptions,
): boolean {
  return (
    basePolicy !== "disabled" &&
    allowsCommandChain(
      line,
      (command) => isCoveredWithoutAsking(command, trustedRules, basePolicy),
      options,
    )
  );
}

/**
 * The rules to add to the trusted list so this line runs without asking next
 * time, or undefined (see rulesToRemember)
 */
export function trustedCommandRulesToRemember(
  line: string,
  trustedRules: readonly string[],
  basePolicy: ToolPolicy,
  options?: ChainOptions,
): string[] | undefined {
  if (basePolicy === "disabled") {
    return undefined;
  }
  return rulesToRemember(
    line,
    (command) => isCoveredWithoutAsking(command, trustedRules, basePolicy),
    options,
  );
}

function isCoveredWithoutAsking(
  command: ChainCommand,
  trustedRules: readonly string[],
  basePolicy: ToolPolicy,
): boolean {
  return (
    trustedRules.some(
      (rule) =>
        isValidCommandRule(rule) &&
        commandMatchesAllowRule(command.words, rule),
    ) ||
    evaluateTerminalCommandSecurity(basePolicy, command.text) ===
      "allowedWithoutPermission"
  );
}
