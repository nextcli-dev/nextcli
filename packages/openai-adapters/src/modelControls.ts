import {
  anthropicEffortLevels,
  anthropicFastMode,
  anthropicThinksByDefault,
  parseClaudeModelVersion,
} from "./apis/AnthropicUtils.js";
import { isResponsesModel } from "./apis/openaiResponses.js";

/**
 * Which request format a model's controls are written in. It follows the
 * adapter the request goes through, not the model vendor: a Claude model on
 * OpenRouter uses OpenRouter's fields.
 */
export type ControlsFormat =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "deepseek"
  | "moonshot"
  | "generic";

export interface ModelControls {
  format: ControlsFormat;
  /** Selectable effort levels, lowest first. Empty when there are none */
  efforts: string[];
  /** Whether the model can return readable reasoning to show */
  canShowThinking: boolean;
  /**
   * True when the model only thinks once an effort is set (Claude 4.6 to
   * 4.8), so Show thinking alone has no effect
   */
  thinkingNeedsEffort: boolean;
  /** Whether a fast or priority mode exists */
  fast: boolean;
  /** Largest context window known for the model, if known */
  maxContextLength?: number;
  /** True when the levels are a best guess (gateways, unknown models) */
  experimental: boolean;
}

export interface ModelControlSettings {
  /** An effort level from ModelControls.efforts, or undefined for default */
  effort?: string;
  showThinking?: boolean;
  fast?: boolean;
}

export interface ModelIdentity {
  provider: string;
  model: string;
  apiBase?: string;
}

const OPENAI_API_BASE = "https://api.openai.com/v1/";
const ONEPROVIDER_PROVIDER = "oneprovider";

/** Strips a vendor prefix such as `anthropic/` (OpenRouter model ids) */
function baseModelName(model: string): string {
  const slash = model.lastIndexOf("/");
  return (slash === -1 ? model : model.slice(slash + 1)).toLowerCase();
}

function isClaude(model: string): boolean {
  return baseModelName(model).startsWith("claude");
}

/** Chat models that accept `service_tier: "priority"` */
function supportsOpenAIPriority(model: string): boolean {
  const name = baseModelName(model);
  return isResponsesModel(name) || /^gpt-4(o|\.1)/.test(name);
}

function isOfficialOpenAI(apiBase: string | undefined): boolean {
  return !apiBase || apiBase.replace(/\/?$/, "/") === OPENAI_API_BASE;
}

/** The request format for a model, following the adapter it goes through */
export function getControlsFormat({
  provider,
  model,
  apiBase,
}: ModelIdentity): ControlsFormat {
  switch (provider) {
    case "anthropic":
      return "anthropic";
    case ONEPROVIDER_PROVIDER:
      // Claude goes through OneProvider's Anthropic Messages endpoint
      return isClaude(model) ? "anthropic" : "generic";
    case "openai":
      return isOfficialOpenAI(apiBase) ? "openai" : "generic";
    case "openrouter":
      return "openrouter";
    case "deepseek":
      return "deepseek";
    case "moonshot":
      return "moonshot";
    default:
      return "generic";
  }
}

/**
 * The per-model settings a model supports: effort levels, readable thinking,
 * fast mode and context window. The CLI's model menu shows only these.
 */
export function getModelControls(identity: ModelIdentity): ModelControls {
  const format = getControlsFormat(identity);
  const { model } = identity;

  switch (format) {
    case "anthropic": {
      const version = parseClaudeModelVersion(model);
      const levels = anthropicEffortLevels(model);
      return {
        format,
        // Models without an effort parameter map levels to thinking budgets
        efforts:
          levels.length > 0 ? levels : version ? ["low", "medium", "high"] : [],
        canShowThinking: !!version,
        thinkingNeedsEffort:
          !!version &&
          version.major === 4 &&
          version.minor >= 6 &&
          !anthropicThinksByDefault(model),
        fast: !!anthropicFastMode(model),
        maxContextLength: version
          ? version.major > 4 || (version.major === 4 && version.minor >= 6)
            ? 1_000_000
            : 200_000
          : undefined,
        experimental: !version,
      };
    }
    case "openai": {
      const reasoning = isResponsesModel(model);
      return {
        format,
        efforts: reasoning ? ["minimal", "low", "medium", "high"] : [],
        canShowThinking: reasoning,
        thinkingNeedsEffort: false,
        fast: supportsOpenAIPriority(model),
        experimental: false,
      };
    }
    case "openrouter": {
      // OpenRouter maps the effort to each vendor's own setting. For Claude
      // the model's levels are known; for other models they're a best guess.
      const claudeLevels = isClaude(model)
        ? anthropicEffortLevels(baseModelName(model))
        : [];
      return {
        format,
        efforts:
          claudeLevels.length > 0 ? claudeLevels : ["low", "medium", "high"],
        canShowThinking: true,
        thinkingNeedsEffort: false,
        fast: false,
        experimental: claudeLevels.length === 0,
      };
    }
    case "deepseek":
      return {
        format,
        // DeepSeek's only control turns thinking off
        efforts: ["off"],
        canShowThinking: true,
        thinkingNeedsEffort: false,
        fast: false,
        experimental: false,
      };
    case "moonshot":
      return {
        format,
        efforts: [],
        canShowThinking: true,
        thinkingNeedsEffort: false,
        fast: false,
        experimental: false,
      };
    case "generic":
      return {
        format,
        efforts: ["low", "medium", "high"],
        canShowThinking: true,
        thinkingNeedsEffort: false,
        fast: false,
        experimental: true,
      };
  }
}

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The supported level closest to the requested one: the highest supported
 * level at or below it, else the lowest supported level. `off` and unknown
 * levels are used only when the model lists them.
 */
export function clampEffort(
  efforts: string[],
  effort: string | undefined,
): string | undefined {
  if (!effort) return undefined;
  if (efforts.includes(effort)) return effort;
  const index = EFFORT_ORDER.indexOf(effort);
  const ordered = EFFORT_ORDER.filter((level) => efforts.includes(level));
  if (index === -1 || ordered.length === 0) return undefined;
  const below = ordered.filter((level) => EFFORT_ORDER.indexOf(level) <= index);
  return below.length > 0 ? below[below.length - 1] : ordered[0];
}

/**
 * Request body fields for the chosen settings, in the format of the adapter
 * the request goes through. Settings the model doesn't support are left out.
 * Fields named `nextcli_*` are read by the adapters and never sent on.
 */
export function buildModelControlFields(
  identity: ModelIdentity,
  settings: ModelControlSettings,
): Record<string, unknown> {
  const controls = getModelControls(identity);
  const effort = clampEffort(controls.efforts, settings.effort);
  const fields: Record<string, unknown> = {};

  switch (controls.format) {
    case "anthropic":
      if (effort) fields.reasoning_effort = effort;
      if (settings.showThinking !== undefined) {
        fields.nextcli_show_thinking = settings.showThinking;
      }
      if (settings.fast && controls.fast) fields.nextcli_fast = true;
      break;
    case "openai":
    case "openrouter":
      if (effort) fields.reasoning_effort = effort;
      if (settings.showThinking !== undefined && controls.canShowThinking) {
        fields.nextcli_show_thinking = settings.showThinking;
      }
      if (settings.fast && controls.fast) {
        fields.service_tier = "priority";
      }
      break;
    case "deepseek":
      if (effort === "off") fields.thinking = { type: "disabled" };
      break;
    case "generic":
      if (effort) fields.reasoning_effort = effort;
      break;
    case "moonshot":
      break;
  }
  return fields;
}
