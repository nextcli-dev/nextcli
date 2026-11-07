/**
 * Base interface for command options that are shared across multiple commands
 * Uses command-line flag names for direct compatibility
 */
export interface BaseCommandOptions {
  /** Path to configuration file (--config) */
  config?: string;
  /** Organization slug to use for this session (--org) */
  org?: string;
  /** Array of rule specifications (--rule) */
  rule?: string[];
  /** Array of MCP server slugs from the hub (--mcp) */
  mcp?: string[];
  /** Array of model slugs from the hub (--model) */
  model?: string[];
  /** Array of prompt slugs from the hub (--prompt) */
  prompt?: string[];
  /** Array of tools to allow (--allow) */
  allow?: string[];
  /** Array of tools to ask permission for (--ask) */
  ask?: string[];
  /** Array of tools to exclude from use (--exclude) */
  exclude?: string[];
  /** Agent file slug from the hub (--agent) */
  agent?: string;
  /** Enable beta UploadArtifact tool */
  betaUploadArtifactTool?: boolean;
  /** Enable beta Subagent tool */
  betaSubagentTool?: boolean;
  /** Stop after this many model calls in one run (--max-turns) */
  maxTurns?: string;
  /** Stop when one run has used more than this many tokens (--max-session-tokens) */
  maxSessionTokens?: string;
  /** Stop when one run has cost more than this many US dollars (--max-cost) */
  maxCost?: string;
  /** Effort level for this run, for example low, medium or high (--effort) */
  effort?: string;
}

/**
 * Extended base options that include verbose and tool control flags
 */
export interface ExtendedCommandOptions extends BaseCommandOptions {
  /** Enable verbose logging */
  verbose?: boolean;
  /** Start in plan mode (backward compatibility) */
  readonly?: boolean;
  /** Start in auto mode (all tools allowed) */
  auto?: boolean;
}
