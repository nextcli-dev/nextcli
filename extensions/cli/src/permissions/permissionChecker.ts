import { splitCommand, type ToolPolicy } from "@continuedev/terminal-security";

import { ALL_BUILT_IN_TOOLS } from "src/tools/allBuiltIns.js";

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
    // Escape all regex metacharacters except * and ?
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    // Convert * and ? to their regex equivalents
    const regexPattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(toolName);
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
      // Convert argValue to string for pattern matching
      const stringValue = String(argValue ?? "");

      // Escape all regex metacharacters except * and ?
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      // Convert * and ? to their regex equivalents
      const regexPattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
      const regex = new RegExp(`^${regexPattern}$`);

      if (!regex.test(stringValue)) {
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
 * Matches a `Bash(glob)` rule against the commands in a shell line (see
 * splitCommand). An allow covers only a line that is one simple command
 * matching the glob, so `Bash(git log*)` doesn't allow `git log; curl x`. An
 * exclude or ask covers a line where any command matches, including one
 * behind a wrapper or inside `sh -c`, and a line splitCommand can't read
 * through (`python -c`, `$CMD`), so it fails closed.
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
    // A missing command is the probe for the tools offered to the model. A
    // command that isn't a string can't be read, so only an exclude or ask
    // covers it.
    return command !== undefined && policy.permission !== "allow";
  }
  const split = splitCommand(command);
  const matches = (words: string[]) =>
    matchesArguments({ command: words.join(" ") }, { command: glob });
  if (policy.permission === "allow") {
    return split.single && !split.opaque && matches(split.commands[0]);
  }
  return split.opaque || split.commands.some(matches);
}

function policyMatches(
  policy: ToolPermissionPolicy,
  toolCall: ToolCallRequest,
): boolean {
  if (!matchesToolPattern(toolCall.name, policy.tool)) {
    return false;
  }
  const commandGlob = policy.argumentMatches?.command;
  if (toolCall.name === "Bash" && typeof commandGlob === "string") {
    return matchesBashCommand(policy, commandGlob, toolCall.arguments?.command);
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

/**
 * True when the model is offered this tool: a call can run without asking,
 * or someone is present to approve it.
 */
export function isToolOffered(
  toolName: string,
  permissions: ToolPermissions,
  isHeadless: boolean,
): boolean {
  const { permission } = checkToolPermission(
    { name: toolName, arguments: {} },
    permissions,
  );
  return permission === "allow" || (permission === "ask" && !isHeadless);
}

/**
 * Evaluates a tool call request against a set of permission policies.
 * Returns the permission for the first matching policy.
 */
export function checkToolPermission(
  toolCall: ToolCallRequest,
  permissions: ToolPermissions,
): PermissionCheckResult {
  const policies = permissions.policies;

  // First, get the base permission from static policies
  let basePermission: PermissionPolicy = "ask";
  let matchedPolicy = undefined;

  for (const policy of policies) {
    if (policyMatches(policy, toolCall)) {
      basePermission = policy.permission;
      matchedPolicy = policy;
      break;
    }
  }

  // Check if tool has dynamic policy evaluation
  const tool = ALL_BUILT_IN_TOOLS.find((t) => t.name === toolCall.name);
  if (tool?.evaluateToolCallPolicy) {
    // Convert CLI permission to core policy
    const basePolicy = permissionPolicyToToolPolicy(basePermission);

    // Evaluate the dynamic policy
    const evaluatedPolicy = tool.evaluateToolCallPolicy(
      basePolicy,
      toolCall.arguments,
    );

    // If dynamic evaluation says disabled, that ALWAYS takes precedence
    if (evaluatedPolicy === "disabled") {
      return {
        permission: "exclude",
        matchedPolicy,
      };
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
