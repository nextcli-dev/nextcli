import { ToolCallPreview } from "../tools/types.js";

export type PermissionPolicy = "allow" | "ask" | "exclude";

export type PermissionMode = "normal" | "plan" | "auto";

export interface ToolPermissionPolicy {
  /** The tool name to match against */
  tool: string;
  /** The permission to apply */
  permission: PermissionPolicy;
  /** Optional argument matching patterns. If not specified, applies to all calls to this tool */
  argumentMatches?: Record<string, any>;
  /**
   * "flag" for a rule given on the command line. In a headless run, an allow
   * from anywhere else (the defaults, an agent file) is evaluated strictly:
   * Bash runs only commands terminal-security approves on its own.
   */
  origin?: "flag";
}

export interface ToolPermissions {
  /** Array of permission policies that are evaluated in order */
  policies: ToolPermissionPolicy[];
  /**
   * --readonly: Edit, MultiEdit and Write are excluded and Bash is evaluated
   * strictly, whatever the policies say.
   */
  readonly?: boolean;
  /** Nobody can approve a call (cn -p, cn review) */
  unattended?: boolean;
}

/**
 * Reads the tool permissions a session runs with. It is read again for each
 * request and tool call, so a mode switch applies right away.
 */
export type ToolPermissionsSource = () => Promise<ToolPermissions>;

export interface ToolCallRequest {
  name: string;
  arguments: Record<string, any>;
  preview?: ToolCallPreview[];
}

export interface PermissionCheckResult {
  permission: PermissionPolicy;
  /** The policy that matched this tool call */
  matchedPolicy?: ToolPermissionPolicy;
}
