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
   * Where the policy came from. A "default" allow is narrowed by a tool's own
   * evaluator (Bash only runs commands it can approve without asking), while
   * an "allow" the operator wrote is taken as given. A policy with no source
   * counts as written by the operator (flags and permissions.yaml).
   */
  source?: "default";
}

export interface ToolPermissions {
  /** Array of permission policies that are evaluated in order */
  policies: ToolPermissionPolicy[];
}

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
