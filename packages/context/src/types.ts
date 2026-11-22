export type ContextSource = "measured" | "estimated" | "configured";

export interface ContextSegment {
  id: string;
  label: string;
  tokens: number;
  source: ContextSource;
  /**
   * Each part counted alone. Their sum can differ from `tokens` by a few
   * at the joins.
   */
  children?: ContextSegment[];
}

/** Signed. `steps[0]` says where the window came from. */
export interface ThresholdStep {
  label: string;
  tokens: number;
}

export interface ContextSnapshot {
  window: number;
  threshold: {
    tokens: number;
    action: "auto-compaction" | "pruning";
    steps: ThresholdStep[];
  };
  segments: ContextSegment[];
  /** The estimate the trigger compares */
  used: number;
  largestToolResults: { label: string; tokens: number }[];
  /** Messages the VS Code pruner shifted out */
  pruned?: { messages: number; tokens: number };
}

export interface FunctionSchema {
  name: string;
  description?: string;
  parameters?: unknown;
}
