import { safeStderr } from "../init.js";
import { getSessionUsage } from "../session.js";
import { AgentLoopLimitError } from "../stream/agentLoopLimitError.js";
import {
  getAgentLoopLimits,
  getLimitReached,
  getPriceSource,
} from "../stream/agentLoopLimits.js";
import { requireFinalAnswer } from "../stream/turnContinuation.js";
import { gracefulExit } from "../util/exit.js";

type UsageSnapshot = {
  promptTokens: number;
  completionTokens: number;
  totalCost: number;
};

/** Headless exit code when a --max-* limit ended the run early */
export const EXIT_CODE_LIMIT_REACHED = 3;

/**
 * Exit code for a finished headless run. A limit, including a wrap-up call
 * that failed after the limit was marked, is 3. Any other error is 1.
 */
export function headlessExitCode(error?: unknown): number {
  if (error instanceof AgentLoopLimitError || getLimitReached()) {
    return EXIT_CODE_LIMIT_REACHED;
  }
  return error ? 1 : 0;
}

/**
 * Starts a headless run: `--format json` must end with an answer. Returns the
 * usage so far, which the run's own usage is counted from.
 */
export function startHeadlessRun(format?: "json"): UsageSnapshot {
  requireFinalAnswer(format === "json");
  return { ...getSessionUsage() };
}

/** Ends a headless run that finished: the usage line, then exit 0 or 3. */
export async function exitHeadlessDone(
  usageAtStart: UsageSnapshot,
  format?: "json",
): Promise<void> {
  writeHeadlessRunSummary(usageAtStart, format);
  await gracefulExit(headlessExitCode());
}

/**
 * Ends a headless run that threw. A limit writes the usage line and exits 3;
 * any other error writes an error line with the usage so far and exits 1.
 */
export async function exitHeadlessOnError(
  error: unknown,
  usageAtStart: UsageSnapshot,
  format?: "json",
): Promise<void> {
  const code = headlessExitCode(error);
  if (code === EXIT_CODE_LIMIT_REACHED) {
    writeHeadlessRunSummary(usageAtStart, format);
  } else {
    writeHeadlessError(error, usageAtStart);
  }
  await gracefulExit(code);
}

/**
 * `--format json` promises an answer on stdout, so a run that ends without
 * one has failed. Plain `-p` may end on tool calls with nothing to say.
 */
export function assertHeadlessAnswer(answer: string, format?: "json"): void {
  if (format === "json" && !answer?.trim()) {
    throw new Error("The model finished without writing an answer.");
  }
}

/**
 * Tells scripts how the run ended and what it cost, on stderr so stdout keeps
 * only the answer. With --format json this is one JSON line:
 * {"status":"done"|"limit","limit":...,"usage":{...}}
 */
export function writeHeadlessRunSummary(
  usageAtStart: UsageSnapshot,
  format?: "json",
): void {
  const limit = getLimitReached() ?? null;
  const priced = getPriceSource() ?? null;
  const maxCost = getAgentLoopLimits().maxCostUsd;

  if (maxCost && priced && priced !== "exact") {
    safeStderr(
      `Warning: this model has no exact price for its host (priced: ${priced}), so the --max-cost limit of $${maxCost} is applied to an estimated cost.` +
        "\n",
    );
  }
  if (format !== "json") {
    return;
  }
  safeStderr(
    JSON.stringify({
      status: limit ? "limit" : "done",
      limit,
      usage: runUsage(usageAtStart),
    }) + "\n",
  );
}

/**
 * Reports a headless run that failed, on stderr, with what it cost so far:
 * {"status":"error","message":...,"usage":{...}}
 */
export function writeHeadlessError(
  error: unknown,
  usageAtStart: UsageSnapshot,
): void {
  const message = error instanceof Error ? error.message : String(error);
  safeStderr(
    JSON.stringify({
      status: "error",
      message,
      usage: runUsage(usageAtStart),
    }) + "\n",
  );
}

/** What this run has used since `usageAtStart`. */
function runUsage(usageAtStart: UsageSnapshot) {
  const usage = getSessionUsage();
  return {
    cost: Number((usage.totalCost - usageAtStart.totalCost).toFixed(6)),
    priced: getPriceSource() ?? null,
    promptTokens: usage.promptTokens - usageAtStart.promptTokens,
    completionTokens: usage.completionTokens - usageAtStart.completionTokens,
  };
}
