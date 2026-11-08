import { ToolPermissionPolicy } from "./types.js";

/**
 * Default permission policies for all built-in tools.
 * These policies are applied in order - first match wins.
 */
export function getDefaultToolPolicies(
  isHeadless = false,
): ToolPermissionPolicy[] {
  const policies: ToolPermissionPolicy[] = tagged([
    // Write tools
    { tool: "Edit", permission: "ask" },
    { tool: "MultiEdit", permission: "ask" },
    { tool: "Write", permission: "ask" },
    { tool: "CheckBackgroundJob", permission: "allow" },
    { tool: "AskQuestion", permission: "allow" },
    { tool: "Checklist", permission: "allow" },
    { tool: "Diff", permission: "allow" },
    { tool: "Skills", permission: "allow" },
    { tool: "Exit", permission: "allow" }, // Exit tool is generally safe (headless mode only)
    // Fetch can send data to any URL, so unattended runs don't get it
    { tool: "Fetch", permission: isHeadless ? "exclude" : "allow" },
    { tool: "List", permission: "allow" },
    { tool: "Read", permission: "allow" },
    { tool: "Search", permission: "allow" },
    { tool: "Status", permission: "allow" },
    { tool: "ReportFailure", permission: "allow" },
    { tool: "UploadArtifact", permission: "allow" },
  ]);

  // Bash, MCP and any other tool ask in the TUI. Nobody is there to answer in
  // a headless run, so MCP and unknown tools are excluded unless the operator
  // opts in with --allow. Bash stays "allow" here, but as a default it only
  // runs the commands its evaluator approves without asking (see
  // checkToolPermission), and anything else is refused.
  policies.push(
    {
      tool: "Bash",
      permission: isHeadless ? "allow" : "ask",
      source: "default",
    },
    {
      tool: "*",
      permission: isHeadless ? "exclude" : "ask",
      source: "default",
    },
  );

  return policies;
}

function tagged(policies: ToolPermissionPolicy[]): ToolPermissionPolicy[] {
  return policies.map((policy) => ({ ...policy, source: "default" }));
}

/**
 * Plan mode (--readonly): a complete override that excludes all writes.
 *
 * Bash can change files (cp, mv, tee, build scripts) and MCP tools can do
 * anything, so a person approves each call in the TUI. Unattended (headless)
 * runs often review untrusted code with a provider key in the environment, so
 * they get no shell, no MCP tools and no Fetch, which could send data out.
 */
export function getPlanModePolicies(
  isHeadless = false,
): ToolPermissionPolicy[] {
  return [
    { tool: "Edit", permission: "exclude" },
    { tool: "MultiEdit", permission: "exclude" },
    { tool: "Write", permission: "exclude" },

    { tool: "Bash", permission: isHeadless ? "exclude" : "ask" },
    { tool: "Fetch", permission: isHeadless ? "exclude" : "allow" },
    { tool: "CheckBackgroundJob", permission: "allow" },
    { tool: "AskQuestion", permission: "allow" },
    { tool: "Checklist", permission: "allow" },
    { tool: "Diff", permission: "allow" },
    { tool: "Exit", permission: "allow" },
    { tool: "List", permission: "allow" },
    { tool: "Read", permission: "allow" },
    { tool: "ReportFailure", permission: "allow" },
    { tool: "Search", permission: "allow" },
    { tool: "Skills", permission: "allow" },
    { tool: "Status", permission: "allow" },
    { tool: "UploadArtifact", permission: "allow" },

    // MCP tools
    { tool: "*", permission: isHeadless ? "exclude" : "ask" },
  ];
}

// Auto mode: Complete override - allow everything without asking
export const AUTO_MODE_POLICIES: ToolPermissionPolicy[] = [
  { tool: "*", permission: "allow" },
];
