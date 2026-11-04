import type { ThinkingMode } from "../modelControls.js";
import {
  type AnthropicSamplingParams,
  filterAnthropicSamplingParams,
  ANTHROPIC_FAST_MODE_BETA,
  anthropicFastMode,
  anthropicThinkingType,
  anthropicThinksByDefault,
  clampAnthropicEffort,
  parseClaudeModelVersion,
} from "./AnthropicUtils.js";

export type AnthropicThinking =
  | { type: "adaptive"; display?: "summarized" | "omitted" }
  | { type: "enabled"; budget_tokens: number }
  | { type: "disabled" };

/** Thinking budgets used for effort levels on models without `effort` */
export const EFFORT_THINKING_BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32000,
  max: 32000,
};
export const MIN_THINKING_BUDGET = 1024;
/** Budget used when thinking is turned on with no effort or budget given */
export const DEFAULT_THINKING_BUDGET = 2048;

export interface AnthropicControlInput {
  model: string;
  /** Requested effort level, clamped to the model's levels */
  effort?: string;
  /**
   * The thinking mode chosen in a model menu. When set, it decides thinking
   * on its own: off sends `disabled`, hidden and shown always turn it on.
   */
  thinking?: ThinkingMode;
  /**
   * Older setting: on adaptive models, whether the text is returned. It
   * doesn't turn thinking on for models that think only when asked.
   */
  showThinking?: boolean;
  /**
   * Turn thinking on without choosing whether the text is returned (the
   * older `reasoning: true` setting). Ignored when `thinking` is set
   */
  thinkingRequested?: boolean;
  /** Explicit thinking budget for models that use `budget_tokens` */
  budgetTokens?: number;
  fast?: boolean;
  maxTokens: number;
}

export interface AnthropicControlParams {
  thinking?: AnthropicThinking;
  outputConfig?: { effort: string };
  speed?: "fast";
  /** max_tokens, raised when a thinking budget needs room */
  maxTokens: number;
  /** Beta flags the request needs in the `anthropic-beta` header */
  betas: string[];
}

/**
 * Claude request settings for the chosen effort, thinking mode and fast
 * mode. Claude 4.6 and newer use adaptive thinking: Claude 5 models think by
 * default, so without a chosen mode it is set only to pick whether the text
 * is returned; Claude 4.6 to 4.8 think only when an effort or budget is
 * given. Older models use a token budget, from the effort level or an
 * explicit budget. Thinking off sends `{ type: "disabled" }`, so no
 * thinking tokens are used, while effort still applies to the answer.
 */
export function anthropicControlParams(
  input: AnthropicControlInput,
): AnthropicControlParams {
  const { model, thinking: mode, showThinking } = input;
  let maxTokens = input.maxTokens;
  const known = !!parseClaudeModelVersion(model);
  const effort = input.effort
    ? clampAnthropicEffort(model, input.effort)
    : undefined;

  let thinking: AnthropicThinking | undefined;
  if (mode === "off") {
    thinking = known ? { type: "disabled" } : undefined;
  } else if (anthropicThinkingType(model) === "adaptive") {
    const display =
      mode !== undefined
        ? mode === "shown"
        : showThinking !== undefined
          ? showThinking
          : undefined;
    const wanted =
      mode !== undefined ||
      !!input.thinkingRequested ||
      (anthropicThinksByDefault(model)
        ? showThinking !== undefined
        : input.effort !== undefined || input.budgetTokens !== undefined);
    if (wanted) {
      thinking = {
        type: "adaptive",
        ...(display !== undefined && {
          display: display ? "summarized" : "omitted",
        }),
      };
    }
  } else if (known) {
    const requested =
      input.budgetTokens ??
      (input.effort ? EFFORT_THINKING_BUDGETS[input.effort] : undefined) ??
      (mode !== undefined || input.thinkingRequested
        ? DEFAULT_THINKING_BUDGET
        : undefined);
    if (requested) {
      // budget_tokens must be at least 1024 and below max_tokens
      const budgetTokens = Math.max(
        MIN_THINKING_BUDGET,
        Math.min(requested, maxTokens - MIN_THINKING_BUDGET),
      );
      thinking = { type: "enabled", budget_tokens: budgetTokens };
      maxTokens = Math.max(maxTokens, budgetTokens + MIN_THINKING_BUDGET);
    }
  }

  const fastMode = input.fast ? anthropicFastMode(model) : undefined;
  return {
    thinking,
    ...(effort && { outputConfig: { effort } }),
    ...(fastMode && { speed: "fast" as const }),
    maxTokens,
    // Fast mode on Opus 5 and Opus 4.8 is a research preview behind a beta
    betas: fastMode === "beta" ? [ANTHROPIC_FAST_MODE_BETA] : [],
  };
}

/**
 * Sampling parameters Claude accepts: while thinking it rejects temperature
 * and top_k and needs top_p between 0.95 and 1. Claude 4.7 and newer reject
 * all three (filterAnthropicSamplingParams).
 */
export function anthropicSamplingParams(
  model: string | undefined,
  params: AnthropicSamplingParams,
  thinkingOn: boolean,
): AnthropicSamplingParams {
  if (thinkingOn) {
    const { topP } = filterAnthropicSamplingParams(model, {
      topP: params.topP,
    });
    return { topP: topP !== undefined && topP >= 0.95 ? topP : undefined };
  }
  return filterAnthropicSamplingParams(model, params);
}

/** Whether the request thinks, so sampling and tool_choice limits apply */
export function anthropicThinkingOn(
  thinking: AnthropicThinking | undefined,
): boolean {
  return thinking !== undefined && thinking.type !== "disabled";
}

/** Adds beta flags to an `anthropic-beta` header value */
export function withAnthropicBetas(
  header: string | undefined,
  betas: string[],
): string | undefined {
  const all = [...(header ? header.split(",") : []), ...betas]
    .map((beta) => beta.trim())
    .filter(Boolean);
  return all.length > 0 ? [...new Set(all)].join(",") : undefined;
}
