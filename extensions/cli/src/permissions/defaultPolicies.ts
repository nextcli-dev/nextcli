import { ToolPermissionPolicy } from "./types.js";

/**
 * Default permission policies for all built-in tools.
 * These policies are applied in order - first match wins.
 */
export function getDefaultToolPolicies(
  isHeadless = false,
): ToolPermissionPolicy[] {
  // Headless closes Fetch, UploadArtifact (they can send data off the
  // machine) and MCP or unknown tools (nobody can approve them). Bash is
  // allow there, but checkToolPermission narrows it to commands the evaluator
  // approves without asking. --allow opts a headless run back in.
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
    {
      tool: "UploadArtifact",
      permission: isHeadless ? "exclude" : "allow",
      source,
    },
    { tool: "Bash", permission: isHeadless ? "allow" : "ask", source },
    { tool: "*", permission: isHeadless ? "exclude" : "ask", source },
  ];
}

/**
 * Plan mode (--readonly) defaults: all writes are excluded. Bash can change
 * files and MCP tools can do anything, so a person approves them in the TUI;
 * unattended runs get neither, and no Fetch. `generateReadOnlyPolicies`
 * applies the operator's flags on top.
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
    { tool: "UploadArtifact", permission: isHeadless ? "exclude" : "allow" },

    // MCP tools
    { tool: "*", permission: isHeadless ? "exclude" : "ask" },
  ];
}

// Auto mode: Complete override - allow everything without asking
export const AUTO_MODE_POLICIES: ToolPermissionPolicy[] = [
  { tool: "*", permission: "allow" },
];
