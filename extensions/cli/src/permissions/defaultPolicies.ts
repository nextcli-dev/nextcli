import { ToolPermissionPolicy } from "./types.js";

/**
 * Default permission policies for all built-in tools.
 * These policies are applied in order - first match wins.
 */
export function getDefaultToolPolicies(
  isHeadless = false,
): ToolPermissionPolicy[] {
  // Bash, MCP and any other tool ask in the TUI. Nobody is there to answer in
  // a headless run, so MCP and unknown tools are excluded unless the operator
  // opts in with --allow. Bash stays "allow" here, but as a default it only
  // runs the commands its evaluator approves without asking (see
  // checkToolPermission), and anything else is refused. Fetch can send data
  // to any URL, so unattended runs don't get it.
  const source = "default" as const;
  return [
    { tool: "Edit", permission: "ask", source },
    { tool: "MultiEdit", permission: "ask", source },
    { tool: "Write", permission: "ask", source },
    { tool: "CheckBackgroundJob", permission: "allow", source },
    { tool: "AskQuestion", permission: "allow", source },
    { tool: "Checklist", permission: "allow", source },
    { tool: "Diff", permission: "allow", source },
    { tool: "Skills", permission: "allow", source },
    { tool: "Exit", permission: "allow", source },
    { tool: "Fetch", permission: isHeadless ? "exclude" : "allow", source },
    { tool: "List", permission: "allow", source },
    { tool: "Read", permission: "allow", source },
    { tool: "Search", permission: "allow", source },
    { tool: "Status", permission: "allow", source },
    { tool: "ReportFailure", permission: "allow", source },
    { tool: "UploadArtifact", permission: "allow", source },
    { tool: "Bash", permission: isHeadless ? "allow" : "ask", source },
    { tool: "*", permission: isHeadless ? "exclude" : "ask", source },
  ];
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
