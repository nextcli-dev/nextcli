import { parse } from "shell-quote";

import {
  classifyDestructiveCommand,
  normalizeCommandName,
} from "./destructiveCommands.js";
import { ToolPolicy } from "./types.js";

/**
 * Token types from shell-quote
 */
interface ShellOperator {
  op: string; // '||', '&&', '|', ';', '>', '>>', '<', '&'
}

interface GlobPattern {
  op: "glob";
  pattern: string;
}

interface CommentToken {
  comment: string;
}

type ParsedToken = string | ShellOperator | GlobPattern | CommentToken;

/**
 * Evaluates the security policy for a terminal command.
 *
 * This function uses shell-quote for proper tokenization, then implements
 * defense-in-depth security validation for terminal commands.
 *
 * Critical commands are disabled, and high-risk or destructive commands, and
 * risky forms of commands such as git or find, require permission. Known
 * build, test and file commands (pytest, tsc, dotnet build, cp...) keep the
 * base policy, so a tool set to automatic runs them without asking, unless
 * `options.strict` is set. Commands the evaluator does not recognise require
 * permission.
 *
 * @param basePolicy The base policy configured for the tool
 * @param command The command string to evaluate
 * @param options Optional strict-mode settings for unattended runs. When
 *   `strict` is true, those build, test and file commands require permission
 *   instead, so a base "allow" only runs commands the evaluator approves on
 *   its own (ls, cat, git status...). Unattended runs use it so a default
 *   allow doesn't run commands that change files.
 * @returns The security policy to apply: 'disabled', 'allowedWithPermission', or 'allowedWithoutPermission'
 */
export function evaluateTerminalCommandSecurity(
  basePolicy: ToolPolicy,
  command: string | null | undefined,
  options?: EvaluateOptions,
): ToolPolicy {
  // Nested evaluations (command substitutions) inherit the caller's mode
  const previous = strictPolicyFollowing;
  if (options?.strict) {
    strictPolicyFollowing = true;
  }
  try {
    return evaluateCommand(basePolicy, command);
  } finally {
    strictPolicyFollowing = previous;
  }
}

export interface EvaluateOptions {
  /**
   * Build, test and file commands (cp, mv, tee, pytest, prettier...) normally
   * follow the base policy. In strict mode they need permission, so a base
   * "allow" only lets through commands the evaluator approves on its own
   * (ls, cat, git status...). Unattended runs use this so a default allow
   * doesn't run commands that change files.
   */
  strict?: boolean;
}

/** Set for the duration of one evaluateTerminalCommandSecurity call (it is synchronous) */
let strictPolicyFollowing = false;

function evaluateCommand(
  basePolicy: ToolPolicy,
  command: string | null | undefined,
): ToolPolicy {
  // If tool is already disabled, keep it disabled
  if (basePolicy === "disabled") {
    return "disabled";
  }

  // Handle null/undefined/empty commands
  if (!command || typeof command !== "string") {
    return basePolicy;
  }

  // Normalize command for analysis
  const normalizedCommand = command.trim();
  if (normalizedCommand === "") {
    return basePolicy;
  }

  // Deletions and disk writes are classified on the whole command, after
  // resolving paths. Catastrophic ones can never run; destructive ones always
  // need permission (the CLI also refuses them in headless mode, see
  // isDestructiveTerminalCommand).
  const destructiveRisk = classifyDestructiveCommand(normalizedCommand);
  if (destructiveRisk === "catastrophic") {
    return "disabled";
  }
  const policy = evaluateCommandPolicy(basePolicy, normalizedCommand);
  return destructiveRisk
    ? getMostRestrictive(policy, "allowedWithPermission")
    : policy;
}

function evaluateCommandPolicy(
  basePolicy: ToolPolicy,
  normalizedCommand: string,
): ToolPolicy {
  try {
    // Split on line breaks to handle multi-line commands
    // Newlines are command separators in shells, similar to semicolons
    const commandLines = normalizedCommand.split(/\r?\n|\r/);

    // If there are multiple lines, evaluate each separately
    if (commandLines.length > 1) {
      let mostRestrictivePolicy: ToolPolicy = basePolicy;

      for (const line of commandLines) {
        const trimmedLine = line.trim();

        // Skip empty lines
        if (trimmedLine === "") {
          continue;
        }

        // Parse and evaluate this line
        const tokens = parse(trimmedLine);
        const linePolicy = evaluateTokensSecurity(
          tokens,
          basePolicy,
          trimmedLine,
        );

        // Track the most restrictive policy
        mostRestrictivePolicy = getMostRestrictive(
          mostRestrictivePolicy,
          linePolicy,
        );

        // If we found a disabled command, return immediately
        if (mostRestrictivePolicy === "disabled") {
          return "disabled";
        }
      }

      return mostRestrictivePolicy;
    }

    // Single line command - parse and evaluate normally
    const tokens = parse(normalizedCommand);

    // Evaluate security of the parsed tokens
    return evaluateTokensSecurity(tokens, basePolicy, normalizedCommand);
  } catch (error) {
    // If parsing fails, be conservative and require permission
    console.error("Failed to parse command:", error);
    return "allowedWithPermission";
  }
}

/**
 * Checks if a token is a shell operator
 */
function isOperator(token: ParsedToken): token is ShellOperator {
  return typeof token === "object" && "op" in token && token.op !== "glob";
}

/**
 * Checks if a token is a glob pattern
 */
function isGlob(token: ParsedToken): token is GlobPattern {
  return typeof token === "object" && "op" in token && token.op === "glob";
}

/**
 * Checks if a token is a comment
 */
function isComment(token: ParsedToken): token is CommentToken {
  return typeof token === "object" && "comment" in token;
}

/**
 * Evaluates the security of parsed shell tokens, handling variable expansion
 */
function evaluateTokensSecurity(
  tokens: ParsedToken[],
  basePolicy: ToolPolicy,
  originalCommand: string,
): ToolPolicy {
  // Check for empty strings that might indicate variable expansion
  const hasEmptyStrings = tokens.some((t) => typeof t === "string" && t === "");

  if (hasEmptyStrings) {
    // Check if original command has legitimate empty quotes
    const hasEmptyQuotes =
      originalCommand.includes('""') || originalCommand.includes("''");
    // Check for variable patterns
    const hasVariablePatterns = /\$[\w{]/.test(originalCommand);

    if (!hasEmptyQuotes || hasVariablePatterns) {
      // Variable expansion detected - evaluate both interpretations

      // 1. Evaluate with empty strings as-is
      const policyWithEmpty = evaluateTokens(
        tokens,
        basePolicy,
        originalCommand,
      );

      // 2. Evaluate without empty strings
      const tokensWithoutEmpty = tokens.filter((t) => t !== "");
      const policyWithoutEmpty =
        tokensWithoutEmpty.length > 0
          ? evaluateTokens(tokensWithoutEmpty, basePolicy, originalCommand)
          : basePolicy;

      // Variable expansion always requires at least permission
      return getMostRestrictive(
        policyWithEmpty,
        policyWithoutEmpty,
        "allowedWithPermission",
      );
    }
  }

  // Normal evaluation for commands without variable expansion
  return evaluateTokens(tokens, basePolicy, originalCommand);
}

/**
 * Core token evaluation logic
 */
function evaluateTokens(
  tokens: ParsedToken[],
  basePolicy: ToolPolicy,
  originalCommand: string,
): ToolPolicy {
  let mostRestrictivePolicy = basePolicy;
  let currentCommand: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Skip comments - they don't affect execution
    if (isComment(token)) {
      continue;
    }

    // Check if token is an operator
    if (isOperator(token)) {
      // Evaluate the current command before the operator
      if (currentCommand.length > 0) {
        const commandPolicy = evaluateSingleCommand(
          currentCommand,
          originalCommand,
          basePolicy,
        );
        mostRestrictivePolicy = getMostRestrictive(
          mostRestrictivePolicy,
          commandPolicy,
        );

        // If we found a disabled command, return immediately
        if (mostRestrictivePolicy === "disabled") {
          return "disabled";
        }
      }

      // Reset for next command
      currentCommand = [];

      // A redirection target is a file, not a command. Writing outside the
      // workspace requires permission (echo x >> ~/.bashrc, > /var/log/syslog)
      const op = (token as ShellOperator).op;
      if (REDIRECT_OPERATORS.includes(op)) {
        // `>|` is parsed as `>` followed by `|`
        let targetIndex = i + 1;
        const next = tokens[targetIndex];
        if (op === ">" && next && isOperator(next) && next.op === "|") {
          targetIndex++;
        }
        const target = tokens[targetIndex];
        // Strict mode: a redirect that writes a file (echo x > notes.txt) is a
        // file change like cp or tee, even inside the workspace
        if (
          strictPolicyFollowing &&
          op !== "<" &&
          op !== "<&" &&
          !(typeof target === "string" && isHarmlessRedirectTarget(op, target))
        ) {
          mostRestrictivePolicy = getMostRestrictive(
            mostRestrictivePolicy,
            "allowedWithPermission",
          );
        }
        if (typeof target === "string") {
          if (
            op !== "<" &&
            op !== "<&" &&
            (isOutsideWorkspacePath(target) || isGitInternalPath(target))
          ) {
            mostRestrictivePolicy = getMostRestrictive(
              mostRestrictivePolicy,
              "allowedWithPermission",
            );
          }
          i = targetIndex;
        }
        continue;
      }

      // Handle pipe operator specially - check if piping to dangerous command
      if ((token as ShellOperator).op === "|") {
        const pipePolicy = evaluatePipeChain(tokens, i);
        mostRestrictivePolicy = getMostRestrictive(
          mostRestrictivePolicy,
          pipePolicy,
        );
        if (mostRestrictivePolicy === "disabled") {
          return "disabled";
        }
      }
    } else if (isGlob(token)) {
      // Handle glob patterns
      currentCommand.push(token.pattern);
    } else if (typeof token === "string") {
      currentCommand.push(token);
    }
  }

  // Evaluate any remaining command
  if (currentCommand.length > 0) {
    const commandPolicy = evaluateSingleCommand(
      currentCommand,
      originalCommand,
      basePolicy,
    );
    mostRestrictivePolicy = getMostRestrictive(
      mostRestrictivePolicy,
      commandPolicy,
    );
  }

  // Also check for command substitution in the original command
  // (shell-quote doesn't parse these as separate tokens)
  if (hasCommandSubstitution(originalCommand)) {
    const substitutedCommands = extractSubstitutedCommands(originalCommand);
    for (const subCmd of substitutedCommands) {
      const nestedPolicy = evaluateTerminalCommandSecurity(basePolicy, subCmd);
      mostRestrictivePolicy = getMostRestrictive(
        mostRestrictivePolicy,
        nestedPolicy,
      );
      if (mostRestrictivePolicy === "disabled") {
        return "disabled";
      }
    }
    // Command substitution itself is risky
    if (mostRestrictivePolicy === "allowedWithoutPermission") {
      mostRestrictivePolicy = "allowedWithPermission";
    }
  }

  // Check for obfuscation patterns
  if (hasObfuscationPatterns(originalCommand)) {
    mostRestrictivePolicy = getMostRestrictive(
      mostRestrictivePolicy,
      "allowedWithPermission",
    );
  }

  return mostRestrictivePolicy;
}

/**
 * Returns the most restrictive policy from multiple policies
 */
function getMostRestrictive(...policies: ToolPolicy[]): ToolPolicy {
  if (policies.some((p) => p === "disabled")) {
    return "disabled";
  }
  if (policies.some((p) => p === "allowedWithPermission")) {
    return "allowedWithPermission";
  }
  return "allowedWithoutPermission";
}

/**
 * Evaluates a pipe chain for dangerous patterns
 */
function evaluatePipeChain(
  tokens: ParsedToken[],
  startIdx: number,
): ToolPolicy {
  // Look at what comes after the pipe
  let nextCommandStart = startIdx + 1;

  // Skip any additional operators
  while (
    nextCommandStart < tokens.length &&
    isOperator(tokens[nextCommandStart])
  ) {
    nextCommandStart++;
  }

  if (nextCommandStart >= tokens.length) {
    return "allowedWithoutPermission";
  }

  // Get the command after the pipe
  const nextCommand: string[] = [];
  for (
    let i = nextCommandStart;
    i < tokens.length && !isOperator(tokens[i]);
    i++
  ) {
    const token = tokens[i];
    if (isComment(token)) {
      continue;
    } else if (isGlob(token)) {
      nextCommand.push(token.pattern);
    } else if (typeof token === "string") {
      nextCommand.push(token);
    }
  }

  if (nextCommand.length > 0) {
    const command = nextCommand[0].toLowerCase();

    // Check for dangerous pipe destinations
    const dangerousPipeCommands = [
      "sh",
      "bash",
      "zsh",
      "python",
      "perl",
      "ruby",
      "node",
    ];
    if (dangerousPipeCommands.includes(command)) {
      return "allowedWithPermission";
    }

    // Check for network exfiltration
    if (
      command === "curl" ||
      command === "wget" ||
      command === "nc" ||
      command === "netcat"
    ) {
      return "allowedWithPermission";
    }
  }

  return "allowedWithoutPermission";
}

/**
 * Evaluates a single command (array of tokens)
 */
function evaluateSingleCommand(
  commandTokens: string[],
  originalCommand: string,
  basePolicy: ToolPolicy,
): ToolPolicy {
  if (commandTokens.length === 0) {
    return "allowedWithoutPermission";
  }

  // Leading variable assignments (`FOO=1 cmd`) apply to the command after
  // them, which is the one to evaluate
  let start = 0;
  while (
    start < commandTokens.length &&
    VARIABLE_ASSIGNMENT.test(commandTokens[start])
  ) {
    start++;
  }
  const assignments = commandTokens.slice(0, start);
  // Variables that change which program runs or what it loads
  // (PATH=/tmp:$PATH ls, LD_PRELOAD=x.so ls) require permission
  const assignsDangerousVariable = assignments.some((assignment) =>
    isDangerousEnvironmentVariable(
      assignment.slice(0, assignment.indexOf("=")),
    ),
  );
  if (start >= commandTokens.length) {
    return assignsDangerousVariable ? "allowedWithPermission" : basePolicy;
  }

  const commandName = commandTokens[start].toLowerCase();
  const args = commandTokens.slice(start + 1);

  // Check for critical commands that should always be disabled
  if (isCriticalCommand(commandName, args)) {
    return "disabled";
  }

  // Handle variable expansion patterns
  if (commandName.startsWith("$")) {
    // Command is a variable - could be anything, so require permission
    return "allowedWithPermission";
  }

  if (assignsDangerousVariable) {
    return "allowedWithPermission";
  }

  // A program named by its path (./build.sh, bin/app, /tmp/x, .\app.exe)
  // is not a command the checks below know, so it requires permission
  if (/[\\/]/.test(commandName.replace(/^\\/, ""))) {
    return "allowedWithPermission";
  }

  // `\rm` bypasses aliases, and Windows commands may carry `.exe`
  const baseCommand = normalizeCommandName(commandName).replace(/\.exe$/, "");

  // Check for high-risk commands that require permission
  if (isHighRiskCommand(baseCommand, args, originalCommand)) {
    return "allowedWithPermission";
  }

  // Check for safe commands. In strict mode, commands this list calls safe
  // but that run repo code or write files (npm run, make, cargo, tar, git
  // branch, git log --output=) need permission. Read-only ones stay approved.
  if (isSafeCommand(baseCommand, args)) {
    if (
      strictPolicyFollowing &&
      strictSafeCommandNeedsPermission(baseCommand, args)
    ) {
      return "allowedWithPermission";
    }
    return "allowedWithoutPermission";
  }

  // Build, test and file commands follow the base policy, except in strict
  // mode (unattended runs), where they require permission (#10512)
  if (isPolicyFollowingCommand(baseCommand, args)) {
    return strictPolicyFollowing ? "allowedWithPermission" : basePolicy;
  }

  // Anything else (argument-checked commands in a risky form such as git push
  // or cargo run, and commands the evaluator doesn't know) requires permission
  return "allowedWithPermission";
}

const VARIABLE_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Environment variables that change which program runs or what code it loads
 */
function isDangerousEnvironmentVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    [
      "PATH",
      "NODE_OPTIONS",
      "NODE_PATH",
      "PYTHONPATH",
      "PYTHONSTARTUP",
      "PYTHONHOME",
      "BASH_ENV",
      "ENV",
      "PERL5OPT",
      "PERL5LIB",
      "RUBYOPT",
      "RUBYLIB",
      "IFS",
      "GIT_SSH",
      "GIT_SSH_COMMAND",
      "GIT_EXEC_PATH",
      "JAVA_TOOL_OPTIONS",
    ].includes(upper) ||
    upper.startsWith("LD_") ||
    upper.startsWith("DYLD_")
  );
}

/**
 * Commands that follow the tool's policy instead of always asking: test
 * runners, compilers, linters and in-workspace file commands. Commands with
 * subcommands only qualify for build and test subcommands (dotnet run and
 * go run execute arbitrary programs, so they ask).
 */
const POLICY_FOLLOWING_COMMANDS = [
  "pytest",
  "py.test",
  "tox",
  "nox",
  "tsc",
  "jest",
  "vitest",
  "mocha",
  "eslint",
  "prettier",
  "ruff",
  "mypy",
  "black",
  "isort",
  "flake8",
  "pylint",
  "msbuild",
  "ctest",
  "cd",
  "pushd",
  "popd",
  "cp",
  "copy",
  "xcopy",
  "robocopy",
  "mv",
  "move",
  "mkdir",
  "md",
  "touch",
  "tee",
];

const POLICY_FOLLOWING_SUBCOMMANDS: Record<string, string[]> = {
  dotnet: ["build", "test", "restore", "format", "clean"],
  go: ["build", "test", "vet", "fmt"],
};

function isPolicyFollowingCommand(
  baseCommand: string,
  args: string[],
): boolean {
  if (POLICY_FOLLOWING_COMMANDS.includes(baseCommand)) {
    return true;
  }
  const subcommands = POLICY_FOLLOWING_SUBCOMMANDS[baseCommand];
  return !!subcommands && args.length > 0 && subcommands.includes(args[0]);
}

/**
 * Checks if a command is critical and should always be disabled
 */
function isCriticalCommand(baseCommand: string, args: string[]): boolean {
  baseCommand = normalizeCommandName(baseCommand);

  // System destruction commands - check if base command starts with mkfs
  if (baseCommand.startsWith("mkfs")) {
    return true;
  }

  // Check for dangerous rm patterns - even if rm is hidden in a variable
  // Combine all tokens to check for dangerous patterns
  const allTokens = [baseCommand, ...args];
  const hasRf =
    allTokens.some(
      (arg) =>
        arg === "-rf" ||
        arg === "-fr" ||
        (arg.startsWith("-") && arg.includes("r") && arg.includes("f")),
    ) ||
    (allTokens.includes("-r") && allTokens.includes("-f")) ||
    (allTokens.includes("--recursive") && allTokens.includes("--force"));

  const hasDangerousPath = allTokens.some(
    (arg) =>
      arg === "/" ||
      arg === "/*" ||
      arg === "~" ||
      arg === "~/*" ||
      arg === "/usr" ||
      arg === "/etc" ||
      arg === "/bin" ||
      arg === "/sbin" ||
      arg.startsWith("/usr/") ||
      arg.startsWith("/etc/") ||
      arg.startsWith("/bin/") ||
      arg.startsWith("/sbin/"),
  );

  // If we have rm flags with dangerous paths, it's critical regardless of command
  if (hasRf && hasDangerousPath) {
    return true;
  }

  // Check for explicit rm command with additional critical paths
  if (baseCommand === "rm") {
    // Check for deletion of critical system files (even without -rf)
    const criticalPaths = [
      "/etc/passwd",
      "/etc/shadow",
      "/etc/sudoers",
      "/etc/hosts",
      "/boot/",
      "/sys/",
      "/proc/",
      "/dev/",
      "/bin/",
      "/sbin/",
      "/usr/bin/",
      "/usr/sbin/",
      "/lib/",
      "/lib64/",
    ];
    if (args.some((arg) => criticalPaths.some((path) => arg.includes(path)))) {
      return true;
    }
  }

  // Windows destructive commands
  if (baseCommand === "del") {
    const hasRecursive = args.includes("/s") && args.includes("/q");
    const hasSystemDrive = args.some(
      (arg) => arg.toLowerCase().includes("c:\\") || arg.includes("c:/"),
    );
    if (hasRecursive || hasSystemDrive) {
      return true;
    }
  }

  if (baseCommand === "format" || baseCommand === "cipher") {
    return true;
  }

  // dd command (disk destroyer)
  if (baseCommand === "dd") {
    if (
      args.some(
        (arg) =>
          arg.includes("of=/dev/") ||
          arg.includes("of=/dev/sda") ||
          arg.includes("of=/dev/disk"),
      )
    ) {
      return true;
    }
  }

  // Privilege escalation
  const privEscCommands = [
    "sudo",
    "su",
    "doas",
    "pkexec",
    "runas",
    "gsudo",
    "psexec",
  ];
  if (privEscCommands.includes(baseCommand)) {
    return true;
  }

  // Permission modification with dangerous flags
  if (baseCommand === "chmod") {
    if (
      args.some(
        (arg) =>
          arg === "777" ||
          arg === "776" ||
          arg === "775" ||
          arg === "+s" ||
          arg === "u+s" ||
          arg === "g+s",
      )
    ) {
      return true;
    }
  }

  if (baseCommand === "chown") {
    if (args.some((arg) => arg.includes("root"))) {
      return true;
    }
  }

  // Windows permission changes
  if (baseCommand === "icacls") {
    if (
      args.some(
        (arg) =>
          arg.toLowerCase().includes("everyone:f") ||
          arg.includes("*s-1-1-0:(oi)(ci)f"), // Everyone SID
      )
    ) {
      return true;
    }
  }

  if (baseCommand === "takeown") {
    return true;
  }

  // Kernel and system modification
  const kernelCommands = [
    "insmod",
    "modprobe",
    "rmmod",
    "iptables",
    "ip6tables",
    "nftables",
  ];
  if (kernelCommands.includes(baseCommand)) {
    return true;
  }

  // Eval and exec commands
  if (baseCommand === "eval" || baseCommand === "exec") {
    return true;
  }

  return false;
}

/**
 * Checks if command is a package manager install
 */
function isHighRiskPackageManager(
  baseCommand: string,
  args: string[],
): boolean {
  const packageManagers = [
    "npm",
    "yarn",
    "pnpm",
    "pip",
    "pip3",
    "gem",
    "cargo",
    "go",
    "apt",
    "apt-get",
    "yum",
    "dnf",
    "zypper",
    "pacman",
    "brew",
    "choco",
    "scoop",
    "winget",
  ];

  if (packageManagers.includes(baseCommand)) {
    // Check for install/add subcommands
    const installCommands = ["install", "add", "i"];
    if (baseCommand === "go") {
      installCommands.push("get");
    }
    if (args.length > 0 && installCommands.includes(args[0])) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if command is a network tool
 */
function isHighRiskNetworkTool(baseCommand: string): boolean {
  const networkTools = [
    "curl",
    "wget",
    "nc",
    "netcat",
    "ncat",
    "telnet",
    "ssh",
    "scp",
    "rsync",
    "ftp",
    "sftp",
    "tftp",
    "socat",
  ];
  return networkTools.includes(baseCommand);
}

/**
 * Checks if command is a script interpreter
 */
function isHighRiskScriptInterpreter(
  baseCommand: string,
  args: string[],
): boolean {
  const scriptInterpreters = [
    "sh",
    "bash",
    "zsh",
    "fish",
    "ksh",
    "csh",
    "tcsh",
    "dash",
    "python",
    "python3",
    "python2",
    "ruby",
    "perl",
    "php",
    "node",
    "nodejs",
    "deno",
    "bun",
    "lua",
    "tcl",
    "powershell",
    "pwsh",
    "cmd",
    "wscript",
    "cscript",
  ];

  baseCommand = baseCommand.replace(/\.exe$/, "");
  if (scriptInterpreters.includes(baseCommand)) {
    // Allow interpreter --help and --version
    if (
      args.length === 1 &&
      (args[0] === "--help" || args[0] === "--version")
    ) {
      return false;
    }
    // Allow interpreter -c for inline commands (we'll check the command content)
    if (args.includes("-c")) {
      // For now, require permission for any -c usage
      return true;
    }
    // If executing a file, require permission
    if (args.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if command is direct script execution
 */
function isHighRiskDirectScript(baseCommand: string): boolean {
  return (
    baseCommand.startsWith("./") ||
    baseCommand.endsWith(".sh") ||
    baseCommand.endsWith(".py") ||
    baseCommand.endsWith(".rb") ||
    baseCommand.endsWith(".pl") ||
    baseCommand.endsWith(".ps1") ||
    baseCommand.endsWith(".bat") ||
    baseCommand.endsWith(".cmd")
  );
}

/**
 * Checks if command modifies environment variables
 */
function isHighRiskEnvironmentModifier(
  baseCommand: string,
  args: string[],
): boolean {
  if (
    baseCommand === "export" ||
    baseCommand === "setx" ||
    baseCommand === "set"
  ) {
    // Check for dangerous environment variables
    const dangerousVars = [
      "PATH",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "PYTHONPATH",
      "NODE_PATH",
      "PERL5LIB",
      "RUBYLIB",
    ];
    if (args.some((arg) => dangerousVars.some((v) => arg.includes(v)))) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if command is process management
 */
function isHighRiskProcessCommand(baseCommand: string): boolean {
  const processCommands = ["kill", "killall", "pkill", "taskkill", "pskill"];
  return processCommands.includes(baseCommand);
}

/**
 * Checks if command is system service management
 */
function isHighRiskSystemService(baseCommand: string): boolean {
  return (
    baseCommand === "systemctl" ||
    baseCommand === "service" ||
    baseCommand === "launchctl" ||
    baseCommand === "sc"
  );
}

/**
 * Checks if command is file operation to sensitive location
 */
function isHighRiskFileOperation(baseCommand: string, args: string[]): boolean {
  if (baseCommand === "mv" || baseCommand === "cp" || baseCommand === "copy") {
    const sensitiveLocations = [
      "/etc/",
      "/usr/",
      "/bin/",
      "/sbin/",
      "c:\\windows",
      "c:\\program",
    ];
    if (
      args.some((arg) =>
        sensitiveLocations.some((loc) => arg.toLowerCase().includes(loc)),
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if rm command is high risk (but not critical)
 */
function isHighRiskRmCommand(baseCommand: string): boolean {
  // Critical deletions are disabled earlier; every other rm, recursive or
  // not, requires permission
  return baseCommand === "rm";
}

/**
 * Checks if command is archive extraction to system directories
 */
function isHighRiskArchiveExtraction(
  baseCommand: string,
  args: string[],
): boolean {
  if (
    baseCommand === "tar" ||
    baseCommand === "unzip" ||
    baseCommand === "7z"
  ) {
    const hasSystemExtraction = args.some((arg, idx) => {
      // Check for -C /path or -d /path patterns
      if (
        (arg === "-C" || arg === "-d" || arg === "-o") &&
        idx < args.length - 1
      ) {
        const nextArg = args[idx + 1];
        return nextArg.startsWith("/") || nextArg.startsWith("C:\\");
      }
      // Check for -C/path patterns
      return (
        arg.startsWith("-C/") || arg.startsWith("-d/") || arg.startsWith("-o/")
      );
    });
    if (hasSystemExtraction) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if command is container/orchestration tool
 */
function isHighRiskContainerCommand(baseCommand: string): boolean {
  const containerCommands = [
    "docker",
    "podman",
    "kubectl",
    "helm",
    "terraform",
    "vagrant",
  ];
  return containerCommands.includes(baseCommand);
}

/**
 * Checks if command is cloud CLI
 */
function isHighRiskCloudCLI(baseCommand: string): boolean {
  const cloudCommands = ["aws", "gcloud", "az", "oci", "ibmcloud"];
  return cloudCommands.includes(baseCommand);
}

/**
 * Checks if command is user/group management
 */
function isHighRiskUserCommand(baseCommand: string): boolean {
  const userCommands = [
    "useradd",
    "usermod",
    "userdel",
    "groupadd",
    "passwd",
    "chpasswd",
  ];
  return userCommands.includes(baseCommand);
}

/**
 * Checks if command is scheduled task
 */
function isHighRiskScheduledTask(baseCommand: string): boolean {
  return (
    baseCommand === "crontab" ||
    baseCommand === "at" ||
    baseCommand === "schtasks"
  );
}

/**
 * Checks if command is Windows registry/system configuration
 */
function isHighRiskWindowsRegistry(baseCommand: string): boolean {
  return (
    baseCommand === "reg" ||
    baseCommand === "regedit" ||
    baseCommand === "regsvr32"
  );
}

/**
 * Checks if command is Windows management tool
 */
function isHighRiskWindowsManagement(baseCommand: string): boolean {
  return (
    baseCommand === "wmic" || baseCommand === "net" || baseCommand === "netsh"
  );
}

/**
 * Checks if command is security/certificate tool
 */
function isHighRiskSecurityTool(baseCommand: string): boolean {
  return baseCommand === "certutil" || baseCommand === "bitsadmin";
}

/**
 * Checks if command is source/dot command
 */
function isHighRiskSourceCommand(baseCommand: string): boolean {
  return baseCommand === "source" || baseCommand === ".";
}

/**
 * Checks if command manipulates history
 */
function isHighRiskHistoryManipulation(
  baseCommand: string,
  args: string[],
): boolean {
  if (baseCommand === "history" && args.includes("-c")) {
    return true;
  }
  if (baseCommand === "unset" && args.some((arg) => arg.includes("HIST"))) {
    return true;
  }
  return false;
}

/**
 * Checks if command is DNS tool (exfiltration risk)
 */
function isHighRiskDNSTool(baseCommand: string): boolean {
  return (
    baseCommand === "dig" ||
    baseCommand === "nslookup" ||
    baseCommand === "host"
  );
}

/**
 * Checks if command is macOS specific high risk
 */
function isHighRiskMacOSCommand(baseCommand: string, args: string[]): boolean {
  if (
    baseCommand === "defaults" &&
    args.some((arg) => arg.includes("/Library/"))
  ) {
    return true;
  }
  if (baseCommand === "pmset" || baseCommand === "csrutil") {
    return true;
  }
  return false;
}

/**
 * Checks if a command is high risk and requires permission
 */
function isHighRiskCommand(
  baseCommand: string,
  args: string[],
  originalCommand: string,
): boolean {
  // Check each category of high risk commands
  if (isHighRiskPackageManager(baseCommand, args)) return true;
  if (isHighRiskNetworkTool(baseCommand)) return true;
  if (isHighRiskScriptInterpreter(baseCommand, args)) return true;
  if (isHighRiskDirectScript(baseCommand)) return true;
  if (isHighRiskEnvironmentModifier(baseCommand, args)) return true;
  if (baseCommand === "alias") return true;
  if (isFunctionDefinition([baseCommand, ...args], originalCommand))
    return true;
  if (isHighRiskProcessCommand(baseCommand)) return true;
  if (isHighRiskSystemService(baseCommand)) return true;
  if (isHighRiskFileOperation(baseCommand, args)) return true;
  if (isHighRiskRmCommand(baseCommand)) return true;
  if (isHighRiskArchiveExtraction(baseCommand, args)) return true;
  if (isHighRiskContainerCommand(baseCommand)) return true;
  if (isHighRiskCloudCLI(baseCommand)) return true;
  if (isHighRiskUserCommand(baseCommand)) return true;
  if (isHighRiskScheduledTask(baseCommand)) return true;
  if (isHighRiskWindowsRegistry(baseCommand)) return true;
  if (isHighRiskWindowsManagement(baseCommand)) return true;
  if (isHighRiskSecurityTool(baseCommand)) return true;
  if (isHighRiskSourceCommand(baseCommand)) return true;
  if (isHighRiskHistoryManipulation(baseCommand, args)) return true;
  if (isHighRiskDNSTool(baseCommand)) return true;
  if (isHighRiskMacOSCommand(baseCommand, args)) return true;
  if (isHighRiskPackageRunner(baseCommand)) return true;
  if (isHighRiskCommandWrapper(baseCommand, args)) return true;
  if (isHighRiskAppLauncher(baseCommand)) return true;
  if (isHighRiskOutsideWorkspacePath(baseCommand, args)) return true;

  return false;
}

/**
 * Checks if command downloads and runs a package (npx, bunx, uvx...)
 */
function isHighRiskPackageRunner(baseCommand: string): boolean {
  return ["npx", "pnpx", "bunx", "uvx"].includes(baseCommand);
}

/**
 * Checks if command runs its arguments as another command. The wrapped
 * command is not evaluated on its own, so it requires permission.
 */
function isHighRiskCommandWrapper(
  baseCommand: string,
  args: string[],
): boolean {
  const wrappers = [
    "xargs",
    "env",
    "nice",
    "ionice",
    "nohup",
    "command",
    "builtin",
    "time",
    "stdbuf",
    "timeout",
    "busybox",
    "toybox",
    "watch",
    "setsid",
    "parallel",
    "script",
  ];
  return wrappers.includes(baseCommand) && args.length > 0;
}

/**
 * Checks if command opens an application, file, or URL
 */
function isHighRiskAppLauncher(baseCommand: string): boolean {
  return ["open", "xdg-open", "gnome-open", "start", "explorer"].includes(
    baseCommand,
  );
}

/**
 * Checks if a command that writes files or changes directory points outside
 * the workspace (cp x ~/.bashrc, tee /etc/hosts, cd ../../etc)
 */
function isHighRiskOutsideWorkspacePath(
  baseCommand: string,
  args: string[],
): boolean {
  if (baseCommand === "shred") {
    return true;
  }
  const pathCommands = [
    "cp",
    "mv",
    "ln",
    "tee",
    "install",
    "touch",
    "mkdir",
    "truncate",
    "chmod",
    "chown",
    "chgrp",
    "rmdir",
    "copy",
    "move",
    "xcopy",
    "robocopy",
    "ren",
    "rename",
    "cd",
    "pushd",
  ];
  if (!pathCommands.includes(baseCommand)) {
    return false;
  }
  // Windows commands take switches such as /Y or /E:x, which are not paths
  const windowsCommands = [
    "copy",
    "move",
    "xcopy",
    "robocopy",
    "ren",
    "rename",
  ];
  return args.some(
    (arg) =>
      !arg.startsWith("-") &&
      !(
        windowsCommands.includes(baseCommand) && /^\/[a-z?]+(:\S*)?$/i.test(arg)
      ) &&
      (isOutsideWorkspacePath(arg) || isGitInternalPath(arg)),
  );
}

/**
 * Checks if a path is inside a `.git` directory, where writes can plant code
 * that git runs later (hooks, config aliases)
 */
function isGitInternalPath(path: string): boolean {
  return /(^|[\\/])\.git([\\/]|$)/.test(path);
}

const REDIRECT_OPERATORS = [">", ">>", ">&", "<", "<&"];

/** `2>/dev/null` and `2>&1` write no file */
function isHarmlessRedirectTarget(op: string, target: string): boolean {
  return (
    target === "/dev/null" ||
    (op === ">&" && (/^\d+$/.test(target) || target === "-"))
  );
}

const HARMLESS_WRITE_TARGETS = ["/dev/null", "/dev/stdout", "/dev/stderr"];

/**
 * Checks if a path is absolute, in the home directory, or climbs out of the
 * current directory with `..`
 */
function isOutsideWorkspacePath(path: string): boolean {
  if (/^\d+$/.test(path) || path === "-") {
    // A file descriptor (2>&1) or stdin/stdout
    return false;
  }
  if (HARMLESS_WRITE_TARGETS.includes(path)) {
    return false;
  }
  return (
    path.startsWith("/") ||
    path.startsWith("~") ||
    /^\$\{?(HOME|USERPROFILE)\b/.test(path) ||
    /^%(USERPROFILE|APPDATA|SYSTEMROOT|WINDIR)%/i.test(path) ||
    /^[a-z]:[\\/]/i.test(path) ||
    path.startsWith("\\\\") ||
    /(^|[\\/])\.\.([\\/]|$)/.test(path)
  );
}

/**
 * `isSafeCommand` approves some commands that run repository code or write
 * files. Strict mode (unattended runs) asks for those and keeps the read-only
 * ones, such as ls, cat and git status.
 */
function strictSafeCommandNeedsPermission(
  baseCommand: string,
  args: string[],
): boolean {
  if (baseCommand === "git") {
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    if (subcommand === "branch" || subcommand === "remote") {
      return true;
    }
    return args.some(
      (arg) => arg === "--output" || arg.startsWith("--output="),
    );
  }
  return (
    baseCommand === "npm" ||
    baseCommand === "yarn" ||
    baseCommand === "pnpm" ||
    baseCommand === "make" ||
    baseCommand === "gradle" ||
    baseCommand === "mvn" ||
    baseCommand === "cargo" ||
    baseCommand === "tar" ||
    baseCommand === "zip"
  );
}

/**
 * Checks if a command is safe and can be auto-approved
 */
function isSafeCommand(baseCommand: string, args: string[]): boolean {
  // Information commands
  const infoCommands = [
    "ls",
    "dir",
    "pwd",
    "whoami",
    "id",
    "hostname",
    "uname",
    "date",
    "uptime",
    "df",
    "du",
    "free",
    "top",
    "htop",
    "ps",
    "jobs",
    "which",
    "whereis",
    "type",
    "file",
    "stat",
    "wc",
    "head",
    "tail",
  ];

  if (infoCommands.includes(baseCommand)) {
    return true;
  }

  // Read-only file operations
  const readCommands = ["cat", "less", "more", "nl", "od", "strings"];
  if (readCommands.includes(baseCommand)) {
    return true;
  }

  // Safe text processing
  if (baseCommand === "echo") {
    return true;
  }

  if (baseCommand === "grep" && !args.includes("--exec")) {
    return true;
  }

  // Safe find (without dangerous flags)
  if (baseCommand === "find") {
    const dangerousFlags = ["-exec", "-execdir", "-ok", "-okdir", "-delete"];
    if (!args.some((arg) => dangerousFlags.includes(arg))) {
      return true;
    }
  }

  // Safe git operations
  if (baseCommand === "git") {
    const safeGitOps = ["status", "log", "diff", "show", "branch", "remote"];
    if (args.length > 0 && safeGitOps.includes(args[0])) {
      return true;
    }
  }

  // Safe npm/yarn commands
  if (
    baseCommand === "npm" ||
    baseCommand === "yarn" ||
    baseCommand === "pnpm"
  ) {
    const safeOps = ["test", "build", "start", "run"];
    if (args.length > 0 && safeOps.includes(args[0])) {
      // Check for suspicious script names
      const suspiciousScripts = [
        "preinstall",
        "postinstall",
        "prepare",
        "prepublish",
      ];
      if (args.length > 1 && !suspiciousScripts.includes(args[1])) {
        return true;
      }
    }
  }

  // Safe build commands
  const buildCommands = ["make", "gradle", "mvn", "cargo"];
  if (buildCommands.includes(baseCommand)) {
    const safeBuildOps = ["build", "compile", "test", "check", "clean"];
    if (args.some((arg) => safeBuildOps.includes(arg))) {
      return true;
    }
  }

  // Safe compression (creation only, not extraction to system paths)
  if (baseCommand === "tar") {
    // Check for create flag
    if (
      args.some((arg) => arg.includes("c")) &&
      !args.some(
        (arg, idx) =>
          (arg === "-C" &&
            idx < args.length - 1 &&
            args[idx + 1].startsWith("/")) ||
          arg.startsWith("-C/"),
      )
    ) {
      return true;
    }
  }

  if (baseCommand === "zip" && !args.some((arg) => arg.startsWith("-d/"))) {
    return true;
  }

  return false;
}

/**
 * Checks for command substitution patterns
 */
function hasCommandSubstitution(command: string): boolean {
  // Backticks
  if (command.includes("`")) {
    return true;
  }

  // $() substitution
  if (command.includes("$(")) {
    return true;
  }

  // Process substitution <() or >()
  if (command.match(/<\(|>\(/)) {
    return true;
  }

  return false;
}

/**
 * Extracts commands from substitution patterns
 */
function extractSubstitutedCommands(command: string): string[] {
  const commands: string[] = [];

  // Extract from backticks
  const backtickMatches = command.match(/`([^`]+)`/g);
  if (backtickMatches) {
    commands.push(...backtickMatches.map((m) => m.slice(1, -1)));
  }

  // Extract from $() - handle nested parentheses
  let idx = 0;
  while (idx < command.length) {
    const dollarParen = command.indexOf("$(", idx);
    if (dollarParen === -1) break;

    // Find matching closing parenthesis
    let depth = 1;
    let endIdx = dollarParen + 2;
    while (endIdx < command.length && depth > 0) {
      if (command[endIdx] === "(") depth++;
      else if (command[endIdx] === ")") depth--;
      endIdx++;
    }

    if (depth === 0) {
      // Extract the command inside $()
      const extracted = command.slice(dollarParen + 2, endIdx - 1);
      commands.push(extracted);
      // Also check for nested substitutions within this command
      if (extracted.includes("$(") || extracted.includes("`")) {
        commands.push(...extractSubstitutedCommands(extracted));
      }
    }

    idx = endIdx;
  }

  return commands;
}

/**
 * Checks if the original command contains a function definition
 */
function isFunctionDefinition(
  tokens: string[],
  originalCommand: string,
): boolean {
  // Check for 'function' keyword as first token
  if (tokens.length > 0 && tokens[0] === "function") {
    return true;
  }

  // Check original command for function definition patterns
  // Patterns: word() {, function word {, function word() {
  const functionPatterns = [
    /^\s*\w+\s*\(\)\s*\{/, // name() {
    /^\s*function\s+\w+\s*\{/, // function name {
    /^\s*function\s+\w+\s*\(\)/, // function name()
  ];

  if (functionPatterns.some((pattern) => pattern.test(originalCommand))) {
    return true;
  }

  return false;
}

/**
 * Checks for obfuscation patterns
 */
function hasObfuscationPatterns(command: string): boolean {
  // Base64 encoding
  if (command.match(/base64\s+-d|base64\s+--decode/)) {
    return true;
  }

  // Hex encoding
  if (command.match(/\\x[0-9a-f]{2}/i)) {
    return true;
  }

  // Unicode escapes
  if (command.match(/\\u[0-9a-f]{4}/i)) {
    return true;
  }

  // Octal escapes
  if (command.match(/\\[0-7]{3}/)) {
    return true;
  }

  // echo -e with escapes
  if (
    command.includes("echo") &&
    command.includes("-e") &&
    command.match(/\\[xnu0-7]/)
  ) {
    return true;
  }

  // Suspicious use of printf
  if (command.includes("printf") && command.match(/\\[xnu0-7]/)) {
    return true;
  }

  // xxd for hex decoding
  if (command.includes("xxd") && command.includes("-r")) {
    return true;
  }

  // od for octal/hex decoding
  if (
    command.includes("od") &&
    (command.includes("-x") || command.includes("-o"))
  ) {
    return true;
  }

  return false;
}
