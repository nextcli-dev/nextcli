import { safeStderr } from "../init.js";
import { getSessionUsage } from "../session.js";
import { AgentLoopLimitError } from "../stream/agentLoopLimitError.js";
import {
  getAgentLoopLimits,
  getLimitReached,
  getPriceSource,
} from "../stream/agentLoopLimits.js";
import { gracefulExit } from "../util/exit.js";

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

/** Writes the usage line and exits 3 when a limit ended the run. */
export async function exitHeadlessAtLimit(
  error: unknown,
  usageAtStart: {
    promptTokens: number;
    completionTokens: number;
    totalCost: number;
  },
  format?: "json",
): Promise<boolean> {
  if (headlessExitCode(error) !== EXIT_CODE_LIMIT_REACHED) {
    return false;
  }
  writeHeadlessRunSummary(usageAtStart, format);
  await gracefulExit(EXIT_CODE_LIMIT_REACHED);
  return true;
}

/**
 * Tells scripts how the run ended and what it cost, on stderr so stdout keeps
 * only the answer. With --format json this is one JSON line:
 * {"status":"done"|"limit","limit":...,"usage":{...}}
 */
export function writeHeadlessRunSummary(
  usageAtStart: {
    promptTokens: number;
    completionTokens: number;
    totalCost: number;
  },
  format?: "json",
): void {
  const usage = getSessionUsage();
  const cost = usage.totalCost - usageAtStart.totalCost;
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
      usage: {
        cost: Number(cost.toFixed(6)),
        priced,
        promptTokens: usage.promptTokens - usageAtStart.promptTokens,
        completionTokens:
          usage.completionTokens - usageAtStart.completionTokens,
      },
    }) + "\n",
  );
}
