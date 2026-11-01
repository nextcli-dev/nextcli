import { getSessionUsage } from "../session.js";

/**
 * Limits that stop a runaway agent loop (#12702, #12853).
 * Configured once from CLI flags; streamChatResponse and handleToolCalls read them.
 */
export interface AgentLoopLimits {
  /** Maximum model calls in one streamChatResponse run */
  maxTurns: number;
  /** Identical consecutive tool calls (same name and arguments) allowed before the next one is canceled */
  maxIdenticalToolCalls: number;
  /** Stop when this run has used more prompt + completion tokens than this */
  maxSessionTokens?: number;
  /** Stop when this run has cost more than this many US dollars */
  maxCostUsd?: number;
}

export const DEFAULT_AGENT_LOOP_LIMITS: AgentLoopLimits = {
  maxTurns: 100,
  maxIdenticalToolCalls: 2,
};

let configuredLimits: AgentLoopLimits = { ...DEFAULT_AGENT_LOOP_LIMITS };

export class AgentLoopLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLoopLimitError";
  }
}

function parsePositiveNumber(
  value: string | number | undefined,
  flag: string,
): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number (got ${value})`);
  }
  return parsed;
}

export function configureAgentLoopLimits(options: {
  maxTurns?: string | number;
  maxSessionTokens?: string | number;
  maxCost?: string | number;
}): void {
  configuredLimits = {
    ...DEFAULT_AGENT_LOOP_LIMITS,
    maxTurns:
      parsePositiveNumber(options.maxTurns, "--max-turns") ??
      DEFAULT_AGENT_LOOP_LIMITS.maxTurns,
    maxSessionTokens: parsePositiveNumber(
      options.maxSessionTokens,
      "--max-session-tokens",
    ),
    maxCostUsd: parsePositiveNumber(options.maxCost, "--max-cost"),
  };
}

export function getAgentLoopLimits(): AgentLoopLimits {
  return configuredLimits;
}

export function resetAgentLoopLimits(): void {
  configuredLimits = { ...DEFAULT_AGENT_LOOP_LIMITS };
}

/** Stable JSON so `{a:1,b:2}` and `{b:2,a:1}` fingerprint the same */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function toolCallFingerprint(name: string, args: unknown): string {
  return `${name}:${stableStringify(args ?? {})}`;
}

export interface UsageSnapshot {
  tokens: number;
  cost: number;
}

export function takeUsageSnapshot(): UsageSnapshot {
  const usage = getSessionUsage();
  return {
    tokens: usage.promptTokens + usage.completionTokens,
    cost: usage.totalCost,
  };
}

/**
 * Stops a runaway loop (#12702, #12853): too many model calls, or more tokens
 * or cost than allowed in this run. Usage is measured from the snapshot taken
 * when the run started, so a resumed session's earlier usage doesn't count.
 */
export function enforceAgentLoopLimits(
  limits: AgentLoopLimits,
  turn: number,
  usageAtStart: UsageSnapshot | undefined,
): void {
  if (turn > limits.maxTurns) {
    throw new AgentLoopLimitError(
      `Stopped after ${limits.maxTurns} model calls in one run. Raise the limit with --max-turns if the task needs more.`,
    );
  }
  if (!usageAtStart) return;
  const current = takeUsageSnapshot();
  const tokensUsed = current.tokens - usageAtStart.tokens;
  const costUsed = current.cost - usageAtStart.cost;
  if (limits.maxSessionTokens && tokensUsed > limits.maxSessionTokens) {
    throw new AgentLoopLimitError(
      `Stopped: this run used ${tokensUsed.toLocaleString()} tokens, over the --max-session-tokens limit of ${limits.maxSessionTokens.toLocaleString()}.`,
    );
  }
  if (limits.maxCostUsd && costUsed > limits.maxCostUsd) {
    throw new AgentLoopLimitError(
      `Stopped: this run cost $${costUsed.toFixed(4)}, over the --max-cost limit of $${limits.maxCostUsd}.`,
    );
  }
}
