import type { ToolPolicy } from "@continuedev/terminal-security";

// JSON Schema compatible parameter definition
export interface ParameterSchema {
  type: string;
  description: string;
  required?: string[];
  properties?: Record<string, ParameterSchema>;
  items?: {
    type: string;
    properties?: Record<string, ParameterSchema>;
    required?: string[];
  };
}

export interface ToolParametersSchema {
  type: "object";
  required?: string[];
  properties: Record<string, ParameterSchema>;
}

export interface ToolCallPreview {
  type: "text" | "diff" | "checklist";
  content: string;
  color?: string;
  paddingLeft?: number;
}

export interface PreprocessToolCallResult {
  preview?: ToolCallPreview[];
  args: Record<string, any>;
  context?: { toolCallId: string };
}

export interface ToolRunContext {
  toolCallId: string;
  /**
   * Number of tool calls being executed in parallel.
   * Tools should divide their output limits by this number to avoid context overflow.
   */
  parallelToolCallCount: number;
  /**
   * Aborted when the turn is interrupted (e.g. SIGINT). Long-running tools
   * should stop and clean up their child processes.
   */
  signal?: AbortSignal;
}

export interface Tool {
  name: string;
  displayName: string;
  description: string;
  parameters: ToolParametersSchema;
  preprocess?: (args: any) => Promise<PreprocessToolCallResult>;
  run: (args: any, context?: ToolRunContext) => Promise<string>;
  readonly?: boolean; // Indicates if the tool is readonly
  isBuiltIn: boolean;
  evaluateToolCallPolicy?: (
    basePolicy: ToolPolicy,
    parsedArgs: Record<string, unknown>,
    options?: {
      /** Approve only calls the tool judges safe on its own; the rest need permission */
      strict?: boolean;
    },
  ) => ToolPolicy;
  /**
   * True when this call must be approved by a person even if a policy allows
   * it: it prompts interactively and is refused in headless mode.
   */
  requiresHumanApproval?: (parsedArgs: Record<string, unknown>) => boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: any;
  argumentsStr: string;
  startNotified: boolean;
  extra_content?: Record<string, unknown>;
}

export interface PreprocessedToolCall extends ToolCall {
  tool: Tool;
  preprocessResult?: PreprocessToolCallResult;
}
