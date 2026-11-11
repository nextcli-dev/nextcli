import { PermissionPolicy, ToolPermissionPolicy } from "./types.js";

type Defaults = {
  /** Terminal UI */
  normal: PermissionPolicy;
  /** cn -p and other runs with nobody to approve a call */
  headless: PermissionPolicy;
  /** --readonly in the terminal UI */
  plan: PermissionPolicy;
  /** --readonly with nobody to approve a call (what nextcli-checks runs) */
  planHeadless: PermissionPolicy;
};

const allow: Defaults = {
  normal: "allow",
  headless: "allow",
  plan: "allow",
  planHeadless: "allow",
};
const write: Defaults = {
  normal: "ask",
  headless: "ask",
  plan: "exclude",
  planHeadless: "exclude",
};
/** Needs a person to respond: excluded when nobody is watching */
const interactive: Defaults = {
  normal: "allow",
  headless: "exclude",
  plan: "allow",
  planHeadless: "exclude",
};
/** Sends data off the machine: closed when nobody is watching */
const network: Defaults = {
  normal: "allow",
  headless: "exclude",
  plan: "allow",
  planHeadless: "exclude",
};

/**
 * The default permission of each built-in tool, in each kind of run. A new
 * built-in tool needs a row here (defaultPolicies.test.ts checks this).
 *
 * Headless Bash is "allow", but a default allow is evaluated strictly
 * (checkToolPermission), so only commands terminal-security approves on its
 * own run. `*` covers MCP and unknown tools; nobody can approve them in a
 * headless run, so they are excluded there. --allow opts a run back in.
 */
const TOOL_DEFAULTS: Record<string, Defaults> = {
  Edit: write,
  MultiEdit: write,
  Write: write,
  AskQuestion: interactive,
  CheckBackgroundJob: allow,
  Checklist: allow,
  Diff: allow,
  Exit: allow,
  List: allow,
  Read: allow,
  ReportFailure: allow,
  Search: allow,
  Skills: allow,
  Status: allow,
  Fetch: network,
  UploadArtifact: network,
  Bash: {
    normal: "ask",
    headless: "allow",
    plan: "ask",
    planHeadless: "exclude",
  },
  Subagent: {
    normal: "ask",
    headless: "exclude",
    plan: "ask",
    planHeadless: "exclude",
  },
  "*": {
    normal: "ask",
    headless: "exclude",
    plan: "ask",
    planHeadless: "exclude",
  },
};

function policiesFor(column: keyof Defaults): ToolPermissionPolicy[] {
  return Object.entries(TOOL_DEFAULTS).map(([tool, defaults]) => ({
    tool,
    permission: defaults[column],
  }));
}

/** Default policies for normal mode. First match wins; `*` is last. */
export function getDefaultToolPolicies(
  isHeadless = false,
): ToolPermissionPolicy[] {
  return policiesFor(isHeadless ? "headless" : "normal");
}

/**
 * Plan mode (--readonly) defaults: writes excluded. A person approves Bash
 * and MCP tools in the terminal UI; a headless run gets neither, and no
 * Fetch, unless --allow opts in. Edit, MultiEdit and Write stay excluded
 * whatever the flags say (checkToolPermission).
 */
export function getPlanModePolicies(
  isHeadless = false,
): ToolPermissionPolicy[] {
  return policiesFor(isHeadless ? "planHeadless" : "plan");
}

// Auto mode: Complete override - allow everything without asking
export const AUTO_MODE_POLICIES: ToolPermissionPolicy[] = [
  { tool: "*", permission: "allow" },
];
