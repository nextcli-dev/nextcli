import {
  calculateRequestCost,
  CostBreakdown,
} from "core/llm/utils/calculateRequestCost";
import type { LLMInteraction } from "../hooks/useLLMLog";

/**
 * An interaction's cost, priced as the CLI prices a request: by the
 * provider, the host the request went to (OneProvider or OpenRouter behind
 * an `openai` provider, a gateway, a local server) and fast mode
 */
export function interactionCost(
  interaction: LLMInteraction | undefined,
): CostBreakdown | null {
  const start = interaction?.start;
  const usage = interaction?.end?.usage;
  if (!start?.provider || !start.options?.model || !usage) {
    return null;
  }
  return calculateRequestCost(start.provider, start.options.model, usage, {
    apiBase: start.apiBase,
    fast: start.options.fast,
  });
}
