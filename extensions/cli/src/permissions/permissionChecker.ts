import type { ToolPolicy } from "@continuedev/terminal-security";

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
 * Supports wildcards (*) for pattern matching.
 * Also handles special Bash command patterns like "Bash(ls*)"
 */
export function matchesToolPattern(
  toolName: string,
  pattern: string,
  toolArguments?: Record<string, any>,
): boolean {
  if (pattern === "*") return true;
  if (pattern === toolName) return true;

  // Handle special Bash command patterns like "Bash(ls*)"
  const bashCommandMatch = pattern.match(/^Bash\((.+)\)$/);
  if (bashCommandMatch) {
    // Check if this is a bash/terminal tool
    const isBashTool = toolName === "Bash";
    if (isBashTool && toolArguments?.command) {
      const commandPattern = bashCommandMatch[1];
      const command = toolArguments.command;

      // Handle command patterns with wildcards
      if (commandPattern.includes("*") || commandPattern.includes("?")) {
        // Escape all regex metacharacters except * and ?
        const escaped = commandPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        // Convert * and ? to their regex equivalents
        const regexPattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(command);
      }

      // Exact command match
      return command === commandPattern;
    }
    return false;
  }

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

/** Shell syntax that runs a second command or writes a file. */
const SHELL_CONTROL = /[&;|`<>\r\n]|\$\(/;

/**
 * The command glob of a Bash rule, whether it was written as `Bash(git log*)`
 * on the command line or parsed from permissions.yaml into argumentMatches.
 */
function bashCommandGlob(policy: ToolPermissionPolicy): string | undefined {
  const inline = /^Bash\((.+)\)$/.exec(policy.tool);
  if (inline) {
    return inline[1];
  }
  const command = policy.argumentMatches?.command;
  if (policy.tool === "Bash" && typeof command === "string") {
    return command;
  }
  return undefined;
}

function isCommandAllowThatChains(
  policy: ToolPermissionPolicy,
  toolCall: ToolCallRequest,
): boolean {
  if (policy.permission !== "allow" || bashCommandGlob(policy) === undefined) {
    return false;
  }
  const command = toolCall.arguments?.command;
  // A missing command is the probe that offers the tool. A command that is
  // present but not a string must not match the pattern allow.
  if (command === undefined) {
    return false;
  }
  if (typeof command !== "string") {
    return true;
  }
  return SHELL_CONTROL.test(command);
}

/**
 * The parts of a command line that the shell runs as separate commands.
 * Quoted text that contains shell syntax is split too, which can only make an
 * `exclude` or `ask` match more often.
 */
function commandSegments(command: string): string[] {
  return command
    .split(/[;&|`<>\r\n()]|\$\(/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * An `exclude` or `ask` written as `Bash(pattern)` also matches each command
 * in a chained line, so `--exclude "Bash(npm install*)"` blocks
 * `ls && npm install` and `echo $(npm install)`.
 */
function matchesChainedCommand(
  policy: ToolPermissionPolicy,
  toolCall: ToolCallRequest,
): boolean {
  const glob = bashCommandGlob(policy);
  const command = toolCall.arguments?.command;
  if (
    policy.permission === "allow" ||
    glob === undefined ||
    typeof command !== "string"
  ) {
    return false;
  }
  return commandSegments(command).some((segment) =>
    matchesToolPattern(toolCall.name, `Bash(${glob})`, {
      ...toolCall.arguments,
      command: segment,
    }),
  );
}

/**
 * True when a tool is allowed only for some arguments, such as `Bash(git
 * log*)`. The tools offered to the model are probed without arguments, which
 * can't match such a policy, so the tool would be hidden. It is offered
 * instead, and each real call is still checked. A policy for the whole tool
 * that comes first, such as `--exclude Bash`, wins.
 */
export function isAllowedForSomeArguments(
  toolName: string,
  permissions: ToolPermissions,
): boolean {
  for (const policy of permissions.policies) {
    const scoped = policy.tool.match(/^(.+?)\((.+)\)$/);
    if (scoped) {
      if (
        policy.permission === "allow" &&
        matchesToolPattern(toolName, scoped[1])
      ) {
        return true;
      }
      continue;
    }
    if (policy.argumentMatches) {
      if (
        policy.permission === "allow" &&
        matchesToolPattern(toolName, policy.tool)
      ) {
        return true;
      }
      continue;
    }
    if (matchesToolPattern(toolName, policy.tool)) {
      return false;
    }
  }
  return false;
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
    if (isCommandAllowThatChains(policy, toolCall)) {
      continue;
    }
    // A chain match already compared each command to the Bash glob, including
    // a permissions.yaml rule stored as argumentMatches. Checking those
    // patterns again would compare them to the whole line and miss the chain.
    const chained = matchesChainedCommand(policy, toolCall);
    if (
      chained ||
      (matchesToolPattern(toolCall.name, policy.tool, toolCall.arguments) &&
        matchesArguments(toolCall.arguments, policy.argumentMatches))
    ) {
      basePermission = policy.permission;
      matchedPolicy = policy;
      break;
    }
  }

  // Check if tool has dynamic policy evaluation
  const tool = ALL_BUILT_IN_TOOLS.find((t) => t.name === toolCall.name);
  if (tool?.evaluateToolCallPolicy) {
    // A default "allow" is only a starting point for a tool that judges its
    // own calls: evaluate strictly, so only calls the tool approves on its
    // own (for Bash, its read-only allow-list) run without a person. An
    // operator's own allow keeps its meaning. Skipped when there are no
    // arguments, which is how the offered tools are probed: the tool stays
    // offered, and each real call is checked.
    const narrowDefaultAllow =
      basePermission === "allow" &&
      matchedPolicy?.source === "default" &&
      Object.keys(toolCall.arguments ?? {}).length > 0;

    // Convert CLI permission to core policy
    const basePolicy = permissionPolicyToToolPolicy(basePermission);

    // Evaluate the dynamic policy
    const evaluatedPolicy = narrowDefaultAllow
      ? tool.evaluateToolCallPolicy(basePolicy, toolCall.arguments, {
          strict: true,
        })
      : tool.evaluateToolCallPolicy(basePolicy, toolCall.arguments);

    // If dynamic evaluation says disabled, that ALWAYS takes precedence
    if (evaluatedPolicy === "disabled") {
      return {
        permission: "exclude",
        matchedPolicy,
      };
    }

    // The tool only approved this call with permission: ask.
    if (narrowDefaultAllow && evaluatedPolicy === "allowedWithPermission") {
      return {
        permission: "ask",
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
