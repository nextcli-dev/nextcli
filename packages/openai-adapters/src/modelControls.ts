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
  | "gemini"
  | "bedrock"
  | "xai"
  | "azure"
  | "generic";

/**
 * How much thinking a request asks for:
 * - `off`: no thinking, so no thinking tokens are used
 * - `hidden`: the model thinks, but the text isn't requested or shown
 * - `shown`: the model thinks and the text is streamed
 */
export type ThinkingMode = "off" | "hidden" | "shown";

export const THINKING_MODES: ThinkingMode[] = ["off", "hidden", "shown"];

export interface ModelControls {
  format: ControlsFormat;
  /** Selectable effort levels, lowest first. Empty when there are none */
  efforts: string[];
  /** Thinking modes the model supports, in THINKING_MODES order */
  thinkingModes: ThinkingMode[];
  /** Why a thinking mode isn't offered, for modes the model lacks */
  thinkingUnavailable: Partial<Record<ThinkingMode, string>>;
  /** The mode used when nothing is chosen and no effort is set */
  defaultThinking?: ThinkingMode;
  /** Whether the model can return readable reasoning to show */
  canShowThinking: boolean;
  /**
   * True when the model only thinks once an effort is set (Claude 4.6 to
   * 4.8), so Show thinking alone has no effect
   */
  thinkingNeedsEffort: boolean;
  /** True when effort has no effect while thinking is off */
  effortNeedsThinking: boolean;
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
  /** The chosen thinking mode, or undefined for the model's default */
  thinking?: ThinkingMode;
  /**
   * Older setting, still read: false hides the thinking text, true shows it.
   * `thinking` wins when both are set.
   */
  showThinking?: boolean;
  fast?: boolean;
}

export interface ModelIdentity {
  provider: string;
  model: string;
  apiBase?: string;
  /**
   * The config sets `reasoning` or `reasoningEffort`, so the model is
   * treated as a reasoning model even when its name isn't recognized
   */
  reasoningConfigured?: boolean;
}

const OPENAI_API_BASE = "https://api.openai.com/v1/";
const ONEPROVIDER_PROVIDER = "oneprovider";

/** Strips a vendor prefix such as `anthropic/` (OpenRouter model ids) */
function baseModelName(model: string): string {
  const slash = model.lastIndexOf("/");
  return (slash === -1 ? model : model.slice(slash + 1)).toLowerCase();
}

function isClaude(model: string): boolean {
  return baseModelName(model).includes("claude");
}

/** Claude 4.6 to 4.8 think only once an effort is set; Claude 5 by default */
function claudeThinkingNeedsEffort(model: string): boolean {
  const version = parseClaudeModelVersion(model);
  return (
    !!version &&
    version.major === 4 &&
    version.minor >= 6 &&
    !anthropicThinksByDefault(model)
  );
}

/** Chat models that accept `service_tier: "priority"` */
function supportsOpenAIPriority(model: string): boolean {
  const name = baseModelName(model);
  return isResponsesModel(name) || /^gpt-4(o|\.1)/.test(name);
}

interface OpenAIReasoningLevels {
  efforts: string[];
  /** Accepts `reasoning.effort: "none"` */
  canTurnOff: boolean;
  /** Newer than the models checked, so the levels are a best guess */
  guessed: boolean;
}

/**
 * Effort levels per OpenAI reasoning model, checked against the live
 * Responses API on 2026-11-04 (models that reject a level return 400):
 * - gpt-5 (and -mini, -nano): minimal to high, no none
 * - gpt-5.1: none, low to high
 * - gpt-5.2 to 5.5: none, low to xhigh
 * - gpt-5.6 and gpt-6: none, low to max
 * - gpt-6.1: low to max, no none
 * - o-series: low to high, no none
 */
export function openAIReasoningLevels(model: string): OpenAIReasoningLevels {
  const name = baseModelName(model);
  if (/^o\d/.test(name)) {
    return {
      efforts: ["low", "medium", "high"],
      canTurnOff: false,
      guessed: false,
    };
  }
  const match = name.match(/^gpt-(\d+)(?:\.(\d+))?/);
  const major = Number(match?.[1] ?? 5);
  const minor = Number(match?.[2] ?? 0);
  const upTo = (top: string) =>
    ["low", "medium", "high", "xhigh", "max"].slice(
      0,
      ["low", "medium", "high", "xhigh", "max"].indexOf(top) + 1,
    );
  if (major === 5 && minor === 0) {
    return {
      efforts: ["minimal", "low", "medium", "high"],
      canTurnOff: false,
      guessed: false,
    };
  }
  if (major === 5 && minor === 1) {
    return { efforts: upTo("high"), canTurnOff: true, guessed: false };
  }
  if (major === 5 && minor <= 5) {
    return { efforts: upTo("xhigh"), canTurnOff: true, guessed: false };
  }
  if ((major === 5 && minor >= 6) || (major === 6 && minor === 0)) {
    return {
      efforts: upTo("max"),
      canTurnOff: true,
      guessed: major === 5 && minor > 6,
    };
  }
  // gpt-6.1 dropped none; newer models are assumed to match it
  return {
    efforts: upTo("max"),
    canTurnOff: false,
    guessed: !(major === 6 && minor === 1),
  };
}

function openAIControls(
  format: "openai" | "azure",
  model: string,
): ModelControls {
  const levels = openAIReasoningLevels(model);
  // Azure's Chat Completions endpoint returns no readable reasoning
  const modes: ThinkingMode[] =
    format === "azure"
      ? levels.canTurnOff
        ? ["off", "hidden"]
        : []
      : levels.canTurnOff
        ? [...THINKING_MODES]
        : ["hidden", "shown"];
  return {
    format,
    efforts: levels.efforts,
    thinkingModes: modes,
    thinkingUnavailable:
      levels.canTurnOff || format === "azure"
        ? format === "azure"
          ? { shown: "Azure's Chat Completions API doesn't return reasoning." }
          : {}
        : {
            off: `${model} can't turn reasoning off. ${levels.efforts[0] === "minimal" ? "Minimal" : "Low"} effort is the lowest.`,
          },
    // Readable summaries can need a verified organization
    defaultThinking: "hidden",
    canShowThinking: format === "openai",
    thinkingNeedsEffort: false,
    effortNeedsThinking: true,
    fast: format === "openai" && supportsOpenAIPriority(model),
    experimental: levels.guessed,
  };
}

interface GeminiVersion {
  major: number;
  minor: number;
  tier: "pro" | "flash" | "flash-lite" | "other";
}

export function parseGeminiModelVersion(
  model: string | undefined,
): GeminiVersion | undefined {
  const match = model
    ?.toLowerCase()
    .match(/gemini-(\d+)(?:\.(\d+))?(?:-(pro|flash-lite|flash))?/);
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    tier: (match[3] as GeminiVersion["tier"] | undefined) ?? "other",
  };
}

/**
 * Gemini 2.5 uses a thinking budget, Gemini 3 and newer a thinking level.
 * Pro models always think. Gemini 2.5 Flash and Flash-Lite turn it off with
 * a budget of 0. On Gemini 3 and newer only Flash-Lite can: OpenRouter
 * rejects turning it off for 3.5 Flash and 3.1 Pro ("Reasoning is
 * mandatory", checked 2026-11-04). Versions after 3.1 are a best guess.
 */
function geminiControls(model: string): ModelControls {
  const version = parseGeminiModelVersion(model);
  const thinks =
    !!version &&
    (version.major >= 3 || (version.major === 2 && version.minor >= 5));
  if (!version || !thinks) {
    return noControls("gemini", version ? false : true);
  }
  const canTurnOff =
    version.tier === "flash-lite" ||
    (version.tier === "flash" && version.major < 3);
  const levels =
    version.major >= 3
      ? version.tier === "pro" || version.tier === "other"
        ? ["low", "high"]
        : ["minimal", "low", "medium", "high"]
      : ["low", "medium", "high"];
  return {
    format: "gemini",
    efforts: levels,
    thinkingModes: canTurnOff ? [...THINKING_MODES] : ["hidden", "shown"],
    thinkingUnavailable: canTurnOff
      ? {}
      : {
          off:
            version.tier === "pro"
              ? "Gemini Pro models always think. Pick a Flash-Lite model to turn thinking off."
              : "This Gemini model always thinks. Pick a Flash-Lite model to turn thinking off.",
        },
    defaultThinking: "shown",
    canShowThinking: true,
    thinkingNeedsEffort: false,
    effortNeedsThinking: true,
    fast: false,
    maxContextLength: 1_048_576,
    experimental:
      version.tier === "other" ||
      version.major > 3 ||
      (version.major === 3 && version.minor > 1),
  };
}

/**
 * Grok, checked against the live xAI API on 2026-11-04:
 * - grok-4.3 to 4.7 take `reasoning_effort` minimal to xhigh; grok-4.3
 *   also takes "none" (no reasoning tokens), later ones reject it
 * - grok-4.20-*-reasoning and grok-build reject `reasoning_effort` and
 *   always reason
 * - `-non-reasoning` models don't reason
 * All reasoning models return the reasoning in `reasoning_content`.
 */
function xaiControls(model: string): ModelControls {
  const name = baseModelName(model);
  if (!name.startsWith("grok") || name.includes("non-reasoning")) {
    return noControls("xai", !name.startsWith("grok"));
  }
  const version = name.match(/^grok-4\.(\d)(?!\d)/);
  const minor = version ? Number(version[1]) : undefined;
  const takesEffort = minor !== undefined && minor >= 3;
  const canTurnOff = minor === 3;
  const known =
    (minor !== undefined && minor >= 3 && minor <= 7) ||
    /^grok-(4\.20|build|3-mini|code-fast)/.test(name);
  return {
    format: "xai",
    efforts: takesEffort
      ? ["minimal", "low", "medium", "high", "xhigh"]
      : name.startsWith("grok-3-mini")
        ? ["low", "high"]
        : [],
    thinkingModes: canTurnOff ? [...THINKING_MODES] : ["hidden", "shown"],
    thinkingUnavailable: canTurnOff
      ? {}
      : {
          off: `${model} always reasons. Pick a non-reasoning Grok model or grok-4.3 to turn it off.`,
        },
    defaultThinking: "shown",
    canShowThinking: true,
    thinkingNeedsEffort: false,
    effortNeedsThinking: true,
    fast: false,
    maxContextLength: name.startsWith("grok-code-fast") ? 256_000 : undefined,
    experimental: !known,
  };
}

/**
 * Model names that usually mean a reasoning model, for OpenAI-compatible
 * providers whose models aren't otherwise known
 */
export function looksLikeReasoningModel(model: string): boolean {
  const name = baseModelName(model);
  return (
    /(^|[-_.:])(r1|reasoner|reasoning|thinking|think|qwq)([-_.:]|$)/.test(
      name,
    ) ||
    /^(o\d|gpt-5|gpt-6|gpt-oss)/.test(name) ||
    /qwen3|magistral|phi-4-reasoning|minimax-m\d|kimi-k\d|grok-[34]/.test(
      name,
    ) ||
    /deepseek-(v3\.[1-9]|v[4-9])/.test(name) ||
    /glm-(4\.[5-9]|[5-9])/.test(name) ||
    /claude-(3-7|(opus|sonnet|haiku|fable)-[4-9])/.test(name) ||
    /gemini-(2\.5|[3-9])/.test(name)
  );
}

/**
 * Kimi. Checked against the live API on 2026-11-04: Kimi K3 models
 * (kimi-k3, kimi-k3.1-pro, kimi-k3.1-pro-highspeed) think by default,
 * `thinking: { type: "disabled" }` stops it (0 reasoning tokens), and
 * `reasoning_effort` takes low, high or max (max is the default; the API
 * lists these in GET /models). They have a 1M-token context window.
 * `-thinking` models always think; moonshot-v1 and instruct models don't.
 */
function moonshotControls(model: string): ModelControls {
  const name = baseModelName(model);
  if (name.startsWith("moonshot-v1") || name.includes("instruct")) {
    return noControls("moonshot");
  }
  if (name.startsWith("kimi-k3")) {
    return {
      format: "moonshot",
      efforts: ["low", "high", "max"],
      thinkingModes: [...THINKING_MODES],
      thinkingUnavailable: {},
      defaultThinking: "shown",
      canShowThinking: true,
      thinkingNeedsEffort: false,
      effortNeedsThinking: true,
      fast: false,
      maxContextLength: 1_048_576,
      experimental: false,
    };
  }
  return {
    format: "moonshot",
    efforts: [],
    thinkingModes: ["hidden", "shown"],
    thinkingUnavailable: {
      off: "This Kimi model always thinks. Kimi K3 models can turn thinking off.",
    },
    defaultThinking: "shown",
    canShowThinking: true,
    thinkingNeedsEffort: false,
    effortNeedsThinking: false,
    fast: false,
    experimental: !name.includes("thinking"),
  };
}

/**
 * OpenRouter maps the effort to each vendor's own setting. Turning
 * reasoning off (`reasoning.enabled: false`) follows the vendor: OpenRouter
 * rejects it for models that must reason ("Reasoning is mandatory": Gemini
 * 3+ Flash and Pro, Grok 4.5 and later), checked 2026-11-04.
 */
function openRouterControls(model: string): ModelControls {
  const slash = model.indexOf("/");
  const vendor = slash === -1 ? "" : model.slice(0, slash).toLowerCase();
  const name = baseModelName(model);
  const claude = isClaude(model)
    ? claudeControls("openrouter", model)
    : undefined;
  const claudeLevels = claude ? anthropicEffortLevels(name) : [];
  const native =
    vendor === "google"
      ? geminiControls(name)
      : vendor === "x-ai"
        ? xaiControls(name)
        : vendor === "moonshotai"
          ? moonshotControls(name)
          : vendor === "openai" && isResponsesModel(name)
            ? openAIControls("openai", name)
            : undefined;
  // OpenRouter can disable reasoning for Kimi and OpenAI even where the
  // vendor rules need a specific model; it refuses for Gemini and Grok
  const canTurnOff =
    vendor === "google" || vendor === "x-ai"
      ? (native?.thinkingModes.includes("off") ?? false)
      : true;
  return {
    format: "openrouter",
    efforts: claudeLevels.length > 0 ? claudeLevels : ["low", "medium", "high"],
    thinkingModes: canTurnOff ? [...THINKING_MODES] : ["hidden", "shown"],
    thinkingUnavailable: canTurnOff
      ? {}
      : {
          off: native?.thinkingUnavailable.off ?? "This model always reasons.",
        },
    defaultThinking: claude?.defaultThinking ?? "shown",
    canShowThinking: true,
    // Without `reasoning`, OpenRouter runs Claude 4.6 to 4.8 with no thinking
    thinkingNeedsEffort: claude?.thinkingNeedsEffort ?? false,
    effortNeedsThinking: !claude || claudeLevels.length === 0,
    fast: false,
    maxContextLength: native?.maxContextLength,
    experimental: claudeLevels.length === 0,
  };
}

function noControls(
  format: ControlsFormat,
  experimental = false,
): ModelControls {
  return {
    format,
    efforts: [],
    thinkingModes: [],
    thinkingUnavailable: {},
    canShowThinking: false,
    thinkingNeedsEffort: false,
    effortNeedsThinking: false,
    fast: false,
    experimental,
  };
}

function claudeControls(
  format: "anthropic" | "bedrock" | "openrouter",
  model: string,
): ModelControls {
  const name = baseModelName(model);
  const version = parseClaudeModelVersion(name);
  if (!version) {
    return noControls(format, true);
  }
  // Extended thinking starts with Claude 3.7; older models only get context
  if (version.major < 3 || (version.major === 3 && version.minor < 7)) {
    return {
      ...noControls(format),
      maxContextLength: 200_000,
    };
  }
  const levels = anthropicEffortLevels(name);
  const needsEffort = claudeThinkingNeedsEffort(name);
  return {
    format,
    // Models without an effort parameter map levels to thinking budgets
    efforts: levels.length > 0 ? levels : ["low", "medium", "high"],
    thinkingModes: [...THINKING_MODES],
    thinkingUnavailable: {},
    // Claude 5 thinks by default; earlier models only when asked
    defaultThinking: anthropicThinksByDefault(name) ? "shown" : "off",
    canShowThinking: true,
    thinkingNeedsEffort: needsEffort,
    // Effort maps to a thinking budget on models without `effort`
    effortNeedsThinking: levels.length === 0,
    fast: format === "anthropic" && !!anthropicFastMode(name),
    maxContextLength:
      version.major > 4 || (version.major === 4 && version.minor >= 6)
        ? 1_000_000
        : 200_000,
    experimental: false,
  };
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
    case "gemini":
      return "gemini";
    case "bedrock":
      return "bedrock";
    case "xAI":
    case "xai":
      return "xai";
    case "azure":
      return "azure";
    default:
      return "generic";
  }
}

/**
 * The per-model settings a model supports: effort levels, thinking modes,
 * fast mode and context window. The model menus show only these.
 */
export function getModelControls(identity: ModelIdentity): ModelControls {
  const format = getControlsFormat(identity);
  const { model } = identity;

  switch (format) {
    case "anthropic":
      return claudeControls("anthropic", model);
    case "bedrock":
      // Bedrock's Converse API takes Claude's thinking settings; other
      // Bedrock models have none
      return isClaude(model)
        ? claudeControls("bedrock", model)
        : noControls("bedrock");
    case "openai":
    case "azure":
      if (!isResponsesModel(baseModelName(model))) {
        return {
          ...noControls(format),
          fast: format === "openai" && supportsOpenAIPriority(model),
        };
      }
      return openAIControls(format, model);
    case "openrouter":
      return openRouterControls(model);
    case "deepseek":
      return {
        format,
        // DeepSeek's only control turns thinking off
        efforts: [],
        thinkingModes: [...THINKING_MODES],
        thinkingUnavailable: {},
        defaultThinking: "shown",
        canShowThinking: true,
        thinkingNeedsEffort: false,
        effortNeedsThinking: false,
        fast: false,
        // deepseek-chat and deepseek-reasoner; a larger configured context
        // length is still offered
        maxContextLength: 128_000,
        experimental: false,
      };
    case "moonshot":
      return moonshotControls(model);
    case "gemini":
      return geminiControls(model);
    case "xai":
      return xaiControls(model);
    case "generic":
      // Only for models that look like reasoning models (or that the
      // config marks as one); others get the context window only
      if (!identity.reasoningConfigured && !looksLikeReasoningModel(model)) {
        return noControls("generic", true);
      }
      return {
        format,
        efforts: ["low", "medium", "high"],
        thinkingModes: ["hidden", "shown"],
        thinkingUnavailable: {
          off: "NextCli can't turn thinking off for this provider.",
        },
        defaultThinking: "shown",
        canShowThinking: true,
        thinkingNeedsEffort: false,
        effortNeedsThinking: false,
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
 * The thinking mode chosen in the settings, if the model supports it. An
 * effort of "off" (the old DeepSeek setting) means thinking off, and the
 * older showThinking flag maps to hidden or shown.
 */
export function chosenThinkingMode(
  controls: ModelControls,
  settings: ModelControlSettings,
): ThinkingMode | undefined {
  const mode =
    settings.thinking ??
    (settings.effort === "off"
      ? "off"
      : settings.showThinking === undefined
        ? undefined
        : settings.showThinking
          ? "shown"
          : "hidden");
  return mode && controls.thinkingModes.includes(mode) ? mode : undefined;
}

/**
 * The thinking mode a request actually runs with: the chosen mode, else the
 * model's default. On models that only think once an effort is set (Claude
 * before 5), setting an effort turns thinking on.
 */
export function effectiveThinkingMode(
  controls: ModelControls,
  settings: ModelControlSettings,
): ThinkingMode | undefined {
  if (controls.thinkingModes.length === 0) {
    return undefined;
  }
  const chosen = chosenThinkingMode(controls, settings);
  if (chosen) {
    return chosen;
  }
  if (
    controls.defaultThinking === "off" &&
    clampEffort(controls.efforts, settings.effort)
  ) {
    return "shown";
  }
  return controls.defaultThinking;
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
  const thinking = chosenThinkingMode(controls, settings);
  const effort =
    thinking === "off" && controls.effortNeedsThinking
      ? undefined
      : clampEffort(controls.efforts, settings.effort);
  const fields: Record<string, unknown> = {};

  switch (controls.format) {
    case "anthropic":
    case "bedrock":
      if (effort) fields.reasoning_effort = effort;
      if (thinking && settings.thinking !== undefined) {
        fields.nextcli_thinking = thinking;
      } else if (thinking) {
        // Older showThinking setting: only chooses whether text is returned
        fields.nextcli_show_thinking = thinking === "shown";
      }
      if (settings.fast && controls.fast) fields.nextcli_fast = true;
      break;
    case "azure":
      if (thinking === "off") {
        fields.reasoning_effort = "none";
      } else if (effort) {
        fields.reasoning_effort = effort;
      }
      break;
    case "openai":
      if (thinking === "off") {
        fields.reasoning_effort = "none";
      } else if (effort) {
        fields.reasoning_effort = effort;
      }
      if (thinking && thinking !== "off") {
        fields.nextcli_show_thinking = thinking === "shown";
      }
      if (settings.fast && controls.fast) {
        fields.service_tier = "priority";
      }
      break;
    case "openrouter":
      if (effort) fields.reasoning_effort = effort;
      if (thinking) {
        // A chosen mode is passed on: Shown asks OpenRouter for the text
        if (settings.thinking !== undefined || thinking === "off") {
          fields.nextcli_thinking = thinking;
        }
        fields.nextcli_show_thinking = thinking === "shown";
      }
      break;
    case "deepseek":
      if (thinking === "off") fields.thinking = { type: "disabled" };
      break;
    case "gemini":
      if (effort) fields.reasoning_effort = effort;
      if (thinking) fields.nextcli_thinking = thinking;
      break;
    case "xai":
      // grok-4.3 takes "none" (no reasoning tokens)
      if (thinking === "off") {
        fields.reasoning_effort = "none";
      } else if (effort) {
        fields.reasoning_effort = effort;
      }
      break;
    case "generic":
      if (effort) fields.reasoning_effort = effort;
      break;
    case "moonshot":
      if (thinking === "off") {
        fields.thinking = { type: "disabled" };
      } else if (effort) {
        fields.reasoning_effort = effort;
      }
      break;
  }
  return fields;
}

const EFFORT_LABELS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortLabel(effort: string | undefined): string {
  return effort ? (EFFORT_LABELS[effort] ?? effort) : "Default";
}

const THINKING_LABELS: Record<ThinkingMode, string> = {
  off: "Off",
  hidden: "Hidden",
  shown: "Shown",
};

export function thinkingLabel(mode: ThinkingMode | undefined): string {
  return mode ? THINKING_LABELS[mode] : "Default";
}

export function formatContextLength(tokens: number): string {
  return tokens >= 1_000_000
    ? `${Number((tokens / 1_000_000).toFixed(2))}M`
    : `${Math.round(tokens / 1000)}K`;
}

const CONTEXT_STEPS = [64_000, 128_000, 200_000, 256_000, 400_000, 1_000_000];

/**
 * Context windows to offer: standard steps up to the largest one known for
 * the model (its own limit, or the configured or default context length).
 */
export function getContextOptions(
  maxContextLength: number | undefined,
  configuredContextLength: number,
): number[] {
  const max = Math.max(maxContextLength ?? 0, configuredContextLength);
  const steps = CONTEXT_STEPS.filter((step) => step < max);
  return [...steps, max];
}
