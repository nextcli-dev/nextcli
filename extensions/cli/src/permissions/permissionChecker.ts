import fs from "fs";
import path from "path";

import {
  allowsCommandChain,
  commandMatchesAllowRule,
  commandMatchesDenyRule,
  globToRegExp,
  splitCommand,
  type ChainCommand,
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
 * Matches a `Bash(glob)` rule. Checking a whole line, an exclude or ask covers
 * it when any command it can see matches (see commandMatchesDenyRule),
 * including one behind a wrapper or inside `sh -c`, and an allow covers
 * nothing: an allow covers commands, so checkToolPermission checks it on
 * each command of a plain chain (`member`). There an allow covers the
 * command as written, so `Bash(git log*)` covers neither `./git log` nor
 * `FOO=1 git log`.
 */
function matchesBashCommand(
  policy: ToolPermissionPolicy,
  glob: string,
  command: unknown,
  member?: ChainCommand,
): boolean {
  if (glob === "*") {
    return true;
  }
  if (member) {
    return policy.permission === "allow"
      ? commandMatchesAllowRule(member.words, glob)
      : commandMatchesDenyRule(member.words, glob);
  }
  if (typeof command !== "string") {
    return matchesUnreadableArgument(policy, command);
  }
  if (policy.permission === "allow") {
    return false;
  }
  return splitCommand(command).commands.some((words) =>
    commandMatchesDenyRule(words, glob),
  );
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
  member?: ChainCommand,
): boolean {
  if (!matchesToolPattern(toolCall.name, policy.tool)) {
    return false;
  }
  const argument = PATTERN_ARGUMENT[toolCall.name];
  const glob = argument ? policy.argumentMatches?.[argument] : undefined;
  if (typeof glob === "string") {
    if (toolCall.name === "Bash") {
      return matchesBashCommand(
        policy,
        glob,
        toolCall.arguments?.command,
        member,
      );
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
 * - A Bash line that this doesn't allow as a whole runs when it is a plain
 *   chain and each of its commands would be allowed as a call of its own
 *   (see allowsCommandChain). That is how `Bash(glob)` allow rules apply: a
 *   chain of `git add` and `git commit` runs under `Bash(git add*)` and
 *   `Bash(git commit*)`.
 */
export function checkToolPermission(
  toolCall: ToolCallRequest,
  permissions: ToolPermissions,
): PermissionCheckResult {
  const result = decide(toolCall, permissions);
  const command = toolCall.arguments?.command;
  if (
    result.permission === "allow" ||
    toolCall.name !== "Bash" ||
    typeof command !== "string"
  ) {
    return result;
  }
  // The rule that allowed the first command, as written, is reported
  let firstMatch: PermissionCheckResult | undefined;
  const allowed = allowsCommandChain(
    command,
    (member) => {
      const memberResult = decideChainCommand(member, permissions, toolCall);
      firstMatch ??= memberResult;
      return memberResult.permission === "allow";
    },
    // The Bash tool runs in this directory
    { cwd: process.cwd() },
  );
  return allowed
    ? { permission: "allow", matchedPolicy: firstMatch?.matchedPolicy }
    : result;
}

/**
 * Whether one command of a plain chain would be allowed as a Bash call of its
 * own, under the same policies, strictness and limits
 */
export function isChainCommandAllowed(
  member: ChainCommand,
  permissions: ToolPermissions,
): boolean {
  return (
    decideChainCommand(member, permissions, { name: "Bash", arguments: {} })
      .permission === "allow"
  );
}

function decideChainCommand(
  member: ChainCommand,
  permissions: ToolPermissions,
  toolCall: ToolCallRequest,
): PermissionCheckResult {
  return decide(
    { ...toolCall, arguments: { ...toolCall.arguments, command: member.text } },
    permissions,
    member,
  );
}

function decide(
  toolCall: ToolCallRequest,
  permissions: ToolPermissions,
  member?: ChainCommand,
): PermissionCheckResult {
  const policies = permissions.policies;

  // First, get the base permission from static policies
  let basePermission: PermissionPolicy = "ask";
  let matchedPolicy: ToolPermissionPolicy | undefined = undefined;

  for (const policy of policies) {
    if (policyMatches(policy, toolCall, member)) {
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
