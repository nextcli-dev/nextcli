import fs from "fs";
import path from "path";

import {
  normalizeCommandName,
  splitCommand,
  type ToolPolicy,
} from "@continuedev/terminal-security";
import { minimatch } from "minimatch";

import { ALL_BUILT_IN_TOOLS } from "src/tools/allBuiltIns.js";

import { PATTERN_ARGUMENT } from "./toolPattern.js";
import {
  PermissionCheckResult,
  PermissionPolicy,
  ToolCallRequest,
  ToolPermissionPolicy,
  ToolPermissions,
} from "./types.js";

/** `*` matches any characters (newlines too), `?` one character */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
    "s",
  );
}

/**
 * Checks if a tool name matches a pattern.
 * Supports wildcards (*) for pattern matching. A rule for some arguments,
 * such as `Bash(ls*)`, is parsed into argumentMatches (see toolPattern.ts).
 */
export function matchesToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === toolName) return true;

  // Handle regular wildcard patterns like "external_*"
  if (pattern.includes("*") || pattern.includes("?")) {
    return globToRegExp(pattern).test(toolName);
  }

  return false;
}

/**
 * Checks if tool call arguments match the specified patterns.
 * Supports glob patterns with * and ? wildcards.
 */
export function matchesArguments(
  args: Record<string, any>,
  patterns?: Record<string, any>,
): boolean {
  if (!patterns) return true;

  for (const [key, pattern] of Object.entries(patterns)) {
    const argValue = args[key];

    if (pattern === "*") continue; // Wildcard matches anything

    // Handle glob patterns with wildcards (only for string patterns)
    if (
      typeof pattern === "string" &&
      (pattern.includes("*") || pattern.includes("?"))
    ) {
      if (!globToRegExp(pattern).test(String(argValue ?? ""))) {
        return false;
      }
    } else {
      // Exact match for non-glob patterns (preserve original behavior)
      if (argValue !== pattern) {
        return false;
      }
    }
  }

  return true;
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
function commandMatchesDenyRule(words: string[], glob: string): boolean {
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
 * Whether a scoped rule covers an argument it can't read. A missing one is
 * the probe for the tools offered to the model (see isToolOffered) and
 * matches no scoped rule; one that isn't a string is covered only by an
 * exclude or ask.
 */
function matchesUnreadableArgument(
  policy: ToolPermissionPolicy,
  value: unknown,
): boolean {
  return value !== undefined && policy.permission !== "allow";
}

/**
 * Matches a `Bash(glob)` rule against the commands in a shell line (see
 * splitCommand). An allow covers only a line that is one simple command, as
 * written, matching the glob, so `Bash(git log*)` doesn't allow
 * `git log; curl x`, `./git log` or `python -c '...'`. An exclude or ask
 * covers a line where any command it can see matches (see
 * commandMatchesDenyRule), including one behind a wrapper or inside `sh -c`.
 */
function matchesBashCommand(
  policy: ToolPermissionPolicy,
  glob: string,
  command: unknown,
): boolean {
  if (glob === "*") {
    return true;
  }
  if (typeof command !== "string") {
    return matchesUnreadableArgument(policy, command);
  }
  const split = splitCommand(command);
  if (policy.permission === "allow") {
    return (
      split.single &&
      !split.opaque &&
      globToRegExp(glob).test(split.commands[0].join(" "))
    );
  }
  return split.commands.some((words) => commandMatchesDenyRule(words, glob));
}

/** The real path, following symlinks, of a path that may not exist yet */
function realPathOf(target: string): string {
  const rest: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return target;
      }
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

const toSlashes = (p: string) => p.split(path.sep).join("/");

/** Tools whose pattern argument (PATTERN_ARGUMENT) is a file path */
const PATH_TOOLS = new Set([
  "Diff",
  "Edit",
  "List",
  "MultiEdit",
  "Read",
  "Write",
]);

/**
 * Matches a `Tool(glob)` rule for a file path (Read, Write, Edit...) the way
 * the tool will use the path: resolved against the working directory, with
 * `..` removed, and with symlinks followed. A relative glob is relative to
 * the working directory; `*` stays within one directory and `**` crosses
 * them. An allow must match both the path as written and the real path, so
 * `Write(src/*)` covers neither `src/../.env` nor a symlink in src/ that
 * points elsewhere. An exclude or ask matches either.
 */
function matchesPathArgument(
  policy: ToolPermissionPolicy,
  glob: string,
  value: unknown,
): boolean {
  if (glob === "*") {
    return true;
  }
  if (typeof value !== "string") {
    return matchesUnreadableArgument(policy, value);
  }
  const cwd = process.cwd();
  const globs = [cwd, realPathOf(cwd)].map((base) =>
    toSlashes(path.resolve(base, glob)),
  );
  const lexical = path.resolve(cwd, value);
  const matches = (p: string) =>
    globs.some((g) => minimatch(toSlashes(p), g, { dot: true }));
  const [asWritten, real] = [matches(lexical), matches(realPathOf(lexical))];
  return policy.permission === "allow" ? asWritten && real : asWritten || real;
}

function policyMatches(
  policy: ToolPermissionPolicy,
  toolCall: ToolCallRequest,
): boolean {
  if (!matchesToolPattern(toolCall.name, policy.tool)) {
    return false;
  }
  const argument = PATTERN_ARGUMENT[toolCall.name];
  const glob = argument ? policy.argumentMatches?.[argument] : undefined;
  if (typeof glob === "string") {
    if (toolCall.name === "Bash") {
      return matchesBashCommand(policy, glob, toolCall.arguments?.command);
    }
    if (PATH_TOOLS.has(toolCall.name)) {
      return matchesPathArgument(policy, glob, toolCall.arguments?.[argument]);
    }
  }
  return matchesArguments(toolCall.arguments, policy.argumentMatches);
}

/**
 * Converts CLI's PermissionPolicy to core's ToolPolicy
 */
function permissionPolicyToToolPolicy(
  permission: PermissionPolicy,
): ToolPolicy {
  switch (permission) {
    case "allow":
      return "allowedWithoutPermission";
    case "ask":
      return "allowedWithPermission";
    case "exclude":
      return "disabled";
    default:
      return "allowedWithPermission";
  }
}

/** The tools --readonly never allows, whatever the policies say */
const WRITE_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

/**
 * True when the model is offered this tool: a call can run without asking,
 * or someone is present to approve it. A tool allowed only for some
 * arguments, such as `Bash(git log*)` or `Write(src/*)`, is offered unless a
 * rule for the whole tool comes first; each real call is still checked.
 */
export function isToolOffered(
  toolName: string,
  permissions: ToolPermissions,
  isHeadless: boolean,
): boolean {
  if (permissions.readonly && WRITE_TOOLS.has(toolName)) {
    return false;
  }
  for (const policy of permissions.policies) {
    if (!matchesToolPattern(toolName, policy.tool)) {
      continue;
    }
    const scoped = Object.values(policy.argumentMatches ?? {}).some(
      (glob) => glob !== "*",
    );
    if (!scoped) {
      break;
    }
    if (
      policy.permission === "allow" ||
      (policy.permission === "ask" && !isHeadless)
    ) {
      return true;
    }
  }
  const { permission } = checkToolPermission(
    { name: toolName, arguments: {} },
    permissions,
  );
  return permission === "allow" || (permission === "ask" && !isHeadless);
}

/**
 * Evaluates a tool call request against a set of permission policies.
 * Returns the permission for the first matching policy, within the run's
 * limits:
 *
 * - --readonly excludes Edit, MultiEdit and Write whatever the policies say.
 * - A tool that judges its own calls (Bash) is evaluated strictly under
 *   --readonly, and in a headless run for any allow that isn't an operator's
 *   flag: only calls it approves on its own run, and the rest ask, which a
 *   headless run refuses.
 */
export function checkToolPermission(
  toolCall: ToolCallRequest,
  permissions: ToolPermissions,
): PermissionCheckResult {
  const policies = permissions.policies;

  // First, get the base permission from static policies
  let basePermission: PermissionPolicy = "ask";
  let matchedPolicy: ToolPermissionPolicy | undefined = undefined;

  for (const policy of policies) {
    if (policyMatches(policy, toolCall)) {
      basePermission = policy.permission;
      matchedPolicy = policy;
      break;
    }
  }

  if (permissions.readonly && WRITE_TOOLS.has(toolCall.name)) {
    return { permission: "exclude", matchedPolicy };
  }

  // Check if tool has dynamic policy evaluation
  const tool = ALL_BUILT_IN_TOOLS.find((t) => t.name === toolCall.name);
  if (tool?.evaluateToolCallPolicy) {
    // Convert CLI permission to core policy
    const basePolicy = permissionPolicyToToolPolicy(basePermission);

    const strict =
      permissions.readonly === true ||
      (permissions.unattended === true && matchedPolicy?.origin !== "flag");

    // Evaluate the dynamic policy
    const evaluatedPolicy = tool.evaluateToolCallPolicy(
      basePolicy,
      toolCall.arguments,
      { strict },
    );

    // If dynamic evaluation says disabled, that ALWAYS takes precedence
    if (evaluatedPolicy === "disabled") {
      return {
        permission: "exclude",
        matchedPolicy,
      };
    }

    // Strict: an allow only covers calls the tool approves on its own
    if (
      strict &&
      basePermission === "allow" &&
      evaluatedPolicy === "allowedWithPermission"
    ) {
      return { permission: "ask", matchedPolicy };
    }

    // An allow policy can't approve a call that needs a person: ask instead.
    // Headless mode refuses "ask", so these never run unattended.
    if (
      basePermission === "allow" &&
      tool.requiresHumanApproval?.(toolCall.arguments)
    ) {
      return {
        permission: "ask",
        matchedPolicy,
      };
    }

    // Otherwise, user preference wins - return the original base permission
    return {
      permission: basePermission,
      matchedPolicy,
    };
  }

  // No dynamic evaluation, return static result
  return {
    permission: basePermission,
    matchedPolicy,
  };
}
