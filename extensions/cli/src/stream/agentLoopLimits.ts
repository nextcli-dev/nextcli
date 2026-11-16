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
  /** Seconds this process may run, from when the limits were set (--max-time) */
  maxSeconds?: number;
  /** When --max-time runs out, in milliseconds since the epoch */
  deadline?: number;
}

export const DEFAULT_AGENT_LOOP_LIMITS: AgentLoopLimits = {
  maxTurns: 100,
  maxIdenticalToolCalls: 2,
};

let configuredLimits: AgentLoopLimits = { ...DEFAULT_AGENT_LOOP_LIMITS };

export type AgentLoopLimitKind = "turns" | "tokens" | "cost" | "time";

/**
 * How a model call was priced: exact for the price the host bills (a maker's
 * list price on its own API, OneProvider's table), catalog from the
 * provider's own price in the models.dev snapshot, estimated for a price the
 * host may not charge (a gateway, a bridge, OpenRouter's general price), or
 * the flat fallback rate.
 */
export type PriceSource = "exact" | "catalog" | "estimated" | "fallback";

const PRICE_SOURCE_RANK: Record<PriceSource, number> = {
  exact: 0,
  catalog: 1,
  estimated: 2,
  fallback: 3,
};

// What happened in this process, for the headless exit code and usage line
let limitReached: AgentLoopLimitKind | undefined;
let priceSource: PriceSource | undefined;
let catalogDate: string | undefined;

/** The limit that ended a run in this process, if any */
export function getLimitReached(): AgentLoopLimitKind | undefined {
  return limitReached;
}

/** The least exact price source of any model call in this process */
export function getPriceSource(): PriceSource | undefined {
  return priceSource;
}

/** The models.dev snapshot's date, when a price in this process came from it */
export function getCatalogDate(): string | undefined {
  return catalogDate;
}

export function recordPriceSource(
  source: PriceSource,
  fromCatalogOf?: string,
): void {
  catalogDate ??= fromCatalogOf;
  if (
    priceSource === undefined ||
    PRICE_SOURCE_RANK[source] > PRICE_SOURCE_RANK[priceSource]
  ) {
    priceSource = source;
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
  maxTime?: string | number;
}): void {
  const maxSeconds = parsePositiveNumber(options.maxTime, "--max-time");
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
    maxSeconds,
    deadline: maxSeconds ? Date.now() + maxSeconds * 1000 : undefined,
  };
}

export function getAgentLoopLimits(): AgentLoopLimits {
  return configuredLimits;
}

export function resetAgentLoopLimits(): void {
  configuredLimits = { ...DEFAULT_AGENT_LOOP_LIMITS };
  limitReached = undefined;
  priceSource = undefined;
  catalogDate = undefined;
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

export interface LimitWrapUp {
  limit: AgentLoopLimitKind;
  /** The limit in words, for the message that asks for a final answer */
  description: string;
  /**
   * The run is already past the limit, so there must not be another model
   * call. Absent when this call can still be the final answer.
   */
  stop?: boolean;
}

export { AgentLoopLimitError } from "./agentLoopLimitError.js";

/**
 * Budget kept for the final answer: at least 10% of the limit, twice the last
 * call, and one more call like the last one followed by the final call itself.
 * The last term matters when a call is expensive: the call after this one
 * grows the prompt, and the final call has to be paid for out of what is left
 * after it, or the final answer gets no room to be written.
 */
function reserveFor(
  limit: number,
  lastCallUsage: number,
  finalCallUsage = 0,
): number {
  return Math.max(
    limit * 0.1,
    lastCallUsage * 2,
    lastCallUsage + finalCallUsage,
  );
}

/**
 * Decides whether the next model call must be the last one (#12702, #12853):
 * it is the last allowed call, or the tokens or dollars left would not cover
 * the call after it. Usage is measured from the snapshot taken when the run
 * started, so a resumed session's earlier usage doesn't count.
 *
 * Returns undefined while the run can continue normally. `stop` is set when
 * the run is already past the limit, so the caller must not make another call.
 */
export function checkAgentLoopLimits(
  limits: AgentLoopLimits,
  turn: number,
  usageAtStart: UsageSnapshot | undefined,
  lastCall: UsageSnapshot | undefined,
  estimateFinalCallCost?: () => number,
): LimitWrapUp | undefined {
  const turns: LimitWrapUp = {
    limit: "turns",
    description: `limit of ${limits.maxTurns} model calls (--max-turns)`,
  };
  if (turn > limits.maxTurns) {
    return { ...turns, stop: true };
  }

  let tokensLeft: number | undefined;
  let costLeft: number | undefined;
  if (usageAtStart) {
    const current = takeUsageSnapshot();
    if (limits.maxSessionTokens) {
      tokensLeft =
        limits.maxSessionTokens - (current.tokens - usageAtStart.tokens);
    }
    if (limits.maxCostUsd) {
      costLeft = limits.maxCostUsd - (current.cost - usageAtStart.cost);
    }
  }

  // Already over: another call would only spend more.
  if (tokensLeft !== undefined && tokensLeft <= 0) {
    return {
      limit: "tokens",
      description: `limit of ${limits.maxSessionTokens!.toLocaleString()} tokens (--max-session-tokens)`,
      stop: true,
    };
  }
  if (costLeft !== undefined && costLeft <= 0) {
    return {
      limit: "cost",
      description: `cost limit of $${limits.maxCostUsd} (--max-cost)`,
      stop: true,
    };
  }

  if (turn >= limits.maxTurns) {
    return turns;
  }
  if (
    limits.maxSessionTokens &&
    tokensLeft !== undefined &&
    tokensLeft < reserveFor(limits.maxSessionTokens, lastCall?.tokens ?? 0)
  ) {
    return {
      limit: "tokens",
      description: `limit of ${limits.maxSessionTokens.toLocaleString()} tokens (--max-session-tokens)`,
    };
  }
  if (
    limits.maxCostUsd &&
    costLeft !== undefined &&
    costLeft <
      reserveFor(
        limits.maxCostUsd,
        lastCall?.cost ?? 0,
        estimateFinalCallCost?.(),
      )
  ) {
    return {
      limit: "cost",
      description: `cost limit of $${limits.maxCostUsd} (--max-cost)`,
    };
  }
  return undefined;
}

/**
 * Decides whether the next model call must be the last one under --max-time:
 * the time left wouldn't cover another turn as long as the last one (its
 * model call, tools and any compaction) and then the final answer, for which
 * a tenth of the limit is kept. Unlike tokens and dollars, time can't be
 * stopped short: past the deadline the final call is still made. The caller's
 * own timeout should leave it a margin.
 */
export function checkTimeLimit(
  limits: AgentLoopLimits,
  lastTurnSeconds: number,
  now = Date.now(),
): LimitWrapUp | undefined {
  if (!limits.maxSeconds || limits.deadline === undefined) {
    return undefined;
  }
  const secondsLeft = (limits.deadline - now) / 1000;
  if (secondsLeft >= lastTurnSeconds + limits.maxSeconds * 0.1) {
    return undefined;
  }
  return {
    limit: "time",
    description: `time limit of ${limits.maxSeconds} seconds (--max-time)`,
  };
}

function markLimitReached(limit: AgentLoopLimitKind): void {
  limitReached = limit;
}

/** Tracks one streamChatResponse run against the configured limits */
export class AgentLoopBudget {
  /**
   * @param estimateFinalCallCost what a final answer would cost now, in US
   * dollars. Only called when --max-cost is set.
   * @param timed whether --max-time applies. A compaction's one call is not
   * timed: a final-answer request there would become the summary.
   */
  constructor(
    private readonly estimateFinalCallCost?: () => number,
    private readonly timed = true,
  ) {}

  private readonly limits = getAgentLoopLimits();
  private readonly tracksUsage = !!(
    this.limits.maxSessionTokens || this.limits.maxCostUsd
  );
  private readonly usageAtStart = this.tracksUsage
    ? takeUsageSnapshot()
    : undefined;
  private lastCall: UsageSnapshot | undefined;
  private turn = 0;
  private lastTurnStartedAt: number | undefined;

  /**
   * Call before each model call. Returns the limit when this call must be
   * the last one, and records it for the headless exit code.
   */
  nextTurn(): LimitWrapUp | undefined {
    this.turn++;
    const now = Date.now();
    const lastTurnSeconds =
      this.lastTurnStartedAt === undefined
        ? 0
        : (now - this.lastTurnStartedAt) / 1000;
    this.lastTurnStartedAt = now;
    const wrapUp =
      checkAgentLoopLimits(
        this.limits,
        this.turn,
        this.usageAtStart,
        this.lastCall,
        this.estimateFinalCallCost,
      ) ??
      (this.timed
        ? checkTimeLimit(this.limits, lastTurnSeconds, now)
        : undefined);
    if (wrapUp) {
      markLimitReached(wrapUp.limit);
    }
    return wrapUp;
  }

  /** Dollars left under --max-cost, or undefined without a cost limit */
  costLeft(): number | undefined {
    if (!this.limits.maxCostUsd || !this.usageAtStart) {
      return undefined;
    }
    return (
      this.limits.maxCostUsd -
      (takeUsageSnapshot().cost - this.usageAtStart.cost)
    );
  }

  /** Runs one model call and remembers what it used */
  async measure<T>(call: () => Promise<T>): Promise<T> {
    if (!this.tracksUsage) {
      return call();
    }
    const before = takeUsageSnapshot();
    const result = await call();
    const after = takeUsageSnapshot();
    this.lastCall = {
      tokens: after.tokens - before.tokens,
      cost: after.cost - before.cost,
    };
    return result;
  }
}

/** Sent before the last model call of a run that reached a limit */
export function wrapUpMessage(wrapUp: LimitWrapUp): string {
  return [
    `This run has reached its ${wrapUp.description}. Stop working now and do not call any tools.`,
    "Give your final answer from what you have found so far, in the format the task asked for.",
    "Say briefly what you did not get to check.",
  ].join(" ");
}
