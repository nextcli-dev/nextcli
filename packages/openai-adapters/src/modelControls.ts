import { catalogPromptLimit, type CatalogModel } from "@nextcli/llm-info";

import {
  anthropicCanDisableThinking,
  anthropicEffortLevels,
  anthropicFastMode,
  anthropicThinksByDefault,
  parseClaudeModelVersion,
} from "./apis/AnthropicUtils.js";
import { isResponsesModel } from "./apis/openaiResponses.js";
import { overriddenEfforts, reasoningOffRejected } from "./catalogOverrides.js";
import {
  baseModelName,
  getControlsFormat,
  isClaude,
  isOneProviderBase,
  resolveModelProfile,
  vendorCatalogModel,
  vendorCatalogProvider,
  type ModelProfile,
} from "./modelProfile.js";

/**
 * The largest context window to offer: the longest prompt the catalog says
 * the model takes (its input limit when that is below the window)
 */
function promptLimit(entry: CatalogModel | undefined): number | undefined {
  return entry ? catalogPromptLimit(entry) : undefined;
}

export { getControlsFormat };

/*
 * Where the controls come from: effort levels, the context window, fast
 * mode and whether a model reasons are read from the models.dev catalog
 * (@nextcli/llm-info, through modelProfile.ts), with the live-checked
 * corrections in catalogOverrides.ts. Whether and how thinking turns off is
 * each API's own rule and stays here, because the catalog doesn't record it
 * for most models. Models the catalog doesn't list get conservative
 * defaults, marked experimental.
 */

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

const ONEPROVIDER_PROVIDER = "oneprovider";
const CONSERVATIVE_EFFORTS = ["low", "medium", "high"];

/**
 * The catalog's effort levels, without "none" (that's thinking off) and
 * "default" (thinking on at the provider's level, which isn't a level)
 */
function catalogEfforts(entry: CatalogModel | undefined): string[] {
  return (entry?.efforts ?? []).filter(
    (effort) => effort !== "none" && effort !== "default",
  );
}

/** The catalog lists "none" among the efforts: reasoning can be turned off */
function turnsOffWithNone(entry: CatalogModel | undefined): boolean {
  return !!entry?.efforts?.includes("none");
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

function openAIControls(
  format: "openai" | "azure",
  model: string,
  entry: CatalogModel | undefined,
): ModelControls {
  const known = !!entry;
  const efforts = known ? catalogEfforts(entry) : CONSERVATIVE_EFFORTS;
  const canTurnOff =
    turnsOffWithNone(entry) &&
    !reasoningOffRejected("openai", baseModelName(model));
  // Azure's Chat Completions endpoint returns no readable reasoning
  const modes: ThinkingMode[] =
    format === "azure"
      ? canTurnOff
        ? ["off", "hidden"]
        : []
      : canTurnOff
        ? [...THINKING_MODES]
        : ["hidden", "shown"];
  return {
    format,
    efforts,
    thinkingModes: modes,
    thinkingUnavailable:
      format === "azure"
        ? { shown: "Azure's Chat Completions API doesn't return reasoning." }
        : canTurnOff
          ? {}
          : {
              off: `${model} can't turn reasoning off. ${efforts[0] === "minimal" ? "Minimal" : "Low"} effort is the lowest.`,
            },
    // Readable summaries can need a verified organization
    defaultThinking: "hidden",
    canShowThinking: format === "openai",
    thinkingNeedsEffort: false,
    effortNeedsThinking: true,
    fast: format === "openai" && !!entry?.fast,
    maxContextLength: promptLimit(entry),
    experimental: !known,
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
 * Gemini 2.5 Flash and Flash-Lite turn thinking off with a budget of 0. On
 * Gemini 3 and newer only Flash-Lite can: OpenRouter rejects turning it off
 * for 3.5 Flash and 3.1 Pro ("Reasoning is mandatory", checked 2026-11-04).
 */
function geminiCanTurnOff(version: GeminiVersion | undefined): boolean {
  return (
    !!version &&
    (version.tier === "flash-lite" ||
      (version.tier === "flash" && version.major < 3))
  );
}

function geminiControls(
  model: string,
  entry: CatalogModel | undefined,
): ModelControls {
  const version = parseGeminiModelVersion(model);
  const reasons = entry ? !!entry.reasoning : looksLikeReasoningModel(model);
  if (!reasons) {
    return {
      ...noControls("gemini", !entry),
      maxContextLength: promptLimit(entry),
    };
  }
  const canTurnOff = geminiCanTurnOff(version);
  // Budgets (2.5) take any level; thinking levels (3+) all take low and high
  const fallback =
    version?.major === 2 ? CONSERVATIVE_EFFORTS : ["low", "high"];
  const efforts = entry?.efforts ? catalogEfforts(entry) : fallback;
  return {
    format: "gemini",
    efforts: efforts.length > 0 ? efforts : fallback,
    thinkingModes: canTurnOff ? [...THINKING_MODES] : ["hidden", "shown"],
    thinkingUnavailable: canTurnOff
      ? {}
      : {
          off:
            version?.tier === "pro"
              ? "Gemini Pro models always think. Pick a Flash-Lite model to turn thinking off."
              : "This Gemini model always thinks. Pick a Flash-Lite model to turn thinking off.",
        },
    defaultThinking: "shown",
    canShowThinking: true,
    thinkingNeedsEffort: false,
    effortNeedsThinking: true,
    fast: false,
    maxContextLength: promptLimit(entry),
    experimental: !entry,
  };
}

/**
 * Grok returns its reasoning in `reasoning_content`. Models that take
 * "none" as an effort (grok-4.3) turn reasoning off; models without effort
 * levels in the catalog (grok-4.20 reasoning, grok-build) reject
 * `reasoning_effort` and always reason.
 */
function xaiControls(
  model: string,
  entry: CatalogModel | undefined,
): ModelControls {
  const name = baseModelName(model);
  const reasons = entry ? !!entry.reasoning : looksLikeReasoningModel(name);
  if (!reasons || name.includes("non-reasoning")) {
    return {
      ...noControls("xai", !entry),
      maxContextLength: promptLimit(entry),
    };
  }
  const canTurnOff = turnsOffWithNone(entry);
  return {
    format: "xai",
    efforts: overriddenEfforts("xai", name) ?? catalogEfforts(entry),
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
    maxContextLength: promptLimit(entry),
    experimental: !entry,
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
    /qwen(?:[3-9]|\d{2})|phi-4-reasoning|minimax-m\d|kimi-k\d|grok-4/.test(
      name,
    ) ||
    // V3.1/V3.2 are retired on DeepSeek's API but still open-weight and
    // hosted elsewhere (Bedrock, self-hosted), where they reason
    /deepseek-(v3\.[1-9]|v[4-9])/.test(name) ||
    /glm-(4\.[5-9]|[5-9])/.test(name) ||
    /claude-(opus|sonnet|haiku|fable)-[4-9]/.test(name) ||
    /gemini-(2\.5|[3-9])/.test(name)
  );
}

/**
 * Kimi, checked against the live API on 2026-11-04: Kimi K3 models think by
 * default and `thinking: { type: "disabled" }` stops it (0 reasoning
 * tokens). `-thinking` models always think; instruct models don't.
 */
function moonshotControls(
  model: string,
  entry: CatalogModel | undefined,
): ModelControls {
  const name = baseModelName(model);
  if (name.includes("instruct") || (entry && !entry.reasoning)) {
    return {
      ...noControls("moonshot"),
      maxContextLength: promptLimit(entry),
    };
  }
  const canTurnOff = name.startsWith("kimi-k3");
  const efforts = catalogEfforts(entry);
  return {
    format: "moonshot",
    efforts,
    thinkingModes: canTurnOff ? [...THINKING_MODES] : ["hidden", "shown"],
    thinkingUnavailable: canTurnOff
      ? {}
      : {
          off: "This Kimi model always thinks. Kimi K3 models can turn thinking off.",
        },
    defaultThinking: "shown",
    canShowThinking: true,
    thinkingNeedsEffort: false,
    effortNeedsThinking: efforts.length > 0,
    fast: false,
    maxContextLength: promptLimit(entry),
    experimental: !entry,
  };
}

/**
 * OpenRouter maps the effort to each vendor's own setting, so the menu
 * lists the vendor's own levels. Turning reasoning off
 * (`reasoning.enabled: false`) follows the vendor: OpenRouter rejects it for
 * models that must reason ("Reasoning is mandatory": Gemini 3+ Flash and
 * Pro, Grok models without "none"), checked 2026-11-04.
 */
function openRouterControls(
  model: string,
  entry: CatalogModel | undefined,
): ModelControls {
  const slash = model.indexOf("/");
  const vendor = slash === -1 ? "" : model.slice(0, slash).toLowerCase();
  const name = baseModelName(model);
  const vendorEntry = vendorCatalogModel(model);
  const claude = isClaude(model)
    ? claudeControls("openrouter", model, vendorEntry)
    : undefined;
  const native =
    vendor === "google"
      ? geminiControls(name, vendorEntry)
      : vendor === "x-ai"
        ? xaiControls(name, vendorEntry)
        : vendor === "moonshotai"
          ? moonshotControls(name, vendorEntry)
          : vendor === "openai" && isResponsesModel(name)
            ? openAIControls("openai", name, vendorEntry)
            : undefined;
  // OpenRouter can disable reasoning for Kimi and OpenAI even where the
  // vendor rules need a specific model; it refuses for Gemini and Grok
  const canTurnOff =
    vendor === "google" || vendor === "x-ai"
      ? (native?.thinkingModes.includes("off") ?? false)
      : true;
  const vendorLevels = claude?.efforts ?? native?.efforts ?? [];
  const known = !!claude || (native ? !native.experimental : false);
  return {
    format: "openrouter",
    efforts: vendorLevels.length > 0 ? vendorLevels : CONSERVATIVE_EFFORTS,
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
    effortNeedsThinking: claude ? claude.effortNeedsThinking : true,
    fast: false,
    maxContextLength: promptLimit(entry) ?? promptLimit(vendorEntry),
    experimental: !(known && vendorLevels.length > 0),
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
  entry: CatalogModel | undefined,
): ModelControls {
  const name = baseModelName(model);
  const version = parseClaudeModelVersion(name);
  if (!version) {
    return noControls(format, true);
  }
  // The catalog's levels; for models it doesn't list, the levels the
  // request code (anthropicControlParams) would send
  const levels = entry?.efforts
    ? catalogEfforts(entry)
    : anthropicEffortLevels(name);
  const needsEffort = claudeThinkingNeedsEffort(name);
  const canTurnOff = anthropicCanDisableThinking(name);
  return {
    format,
    // Models without an effort parameter map levels to thinking budgets
    efforts: levels.length > 0 ? levels : CONSERVATIVE_EFFORTS,
    thinkingModes: canTurnOff
      ? [...THINKING_MODES]
      : THINKING_MODES.filter((mode) => mode !== "off"),
    thinkingUnavailable: canTurnOff
      ? {}
      : { off: "This model always thinks; it can't be turned off." },
    // Claude 5 thinks by default; earlier models only when asked
    defaultThinking: anthropicThinksByDefault(name) ? "shown" : "off",
    canShowThinking: true,
    thinkingNeedsEffort: needsEffort,
    // Effort maps to a thinking budget on models without `effort`
    effortNeedsThinking: levels.length === 0,
    // Fast mode needs its beta header, which the request code adds for the
    // models anthropicFastMode knows
    fast: format === "anthropic" && !!anthropicFastMode(name),
    maxContextLength: promptLimit(entry),
    experimental: !entry,
  };
}

/**
 * DeepSeek's only verified control turns thinking off (catalogOverrides.ts
 * keeps the catalog's effort levels out)
 */
function deepSeekControls(
  model: string,
  entry: CatalogModel | undefined,
): ModelControls {
  return {
    format: "deepseek",
    efforts:
      overriddenEfforts("deepseek", baseModelName(model)) ??
      catalogEfforts(entry),
    thinkingModes: [...THINKING_MODES],
    thinkingUnavailable: {},
    defaultThinking: "shown",
    canShowThinking: true,
    thinkingNeedsEffort: false,
    effortNeedsThinking: false,
    fast: false,
    maxContextLength: promptLimit(entry),
    experimental: false,
  };
}

function genericControls(
  identity: ModelIdentity,
  entry: CatalogModel | undefined,
): ModelControls {
  // A model the catalog knows (OneProvider's non-Claude models): its own
  // levels. Otherwise only models that look like reasoning models (or that
  // the config marks as one) get reasoning rows.
  const reasons = entry
    ? !!entry.reasoning || !!identity.reasoningConfigured
    : !!identity.reasoningConfigured || looksLikeReasoningModel(identity.model);
  if (!reasons) {
    return {
      ...noControls("generic", !entry),
      maxContextLength: promptLimit(entry),
    };
  }
  const levels = catalogEfforts(entry);
  // Guess levels only when the catalog doesn't list them: a model listed
  // with just "none" and "default" takes no level
  const guessed = levels.length === 0 && !entry?.efforts;
  return {
    format: "generic",
    efforts: guessed ? CONSERVATIVE_EFFORTS : levels,
    thinkingModes: ["hidden", "shown"],
    thinkingUnavailable: {
      off: "NextCli can't turn thinking off for this provider.",
    },
    defaultThinking: "shown",
    canShowThinking: true,
    thinkingNeedsEffort: false,
    effortNeedsThinking: false,
    fast: false,
    maxContextLength: promptLimit(entry),
    experimental: guessed,
  };
}

/**
 * The per-model settings a model supports: effort levels, thinking modes,
 * fast mode and context window. The model menus show only these.
 */
export function getModelControls(identity: ModelIdentity): ModelControls {
  const profile: ModelProfile = resolveModelProfile(identity);
  const { model } = identity;
  const entry = profile.catalog;

  let controls: ModelControls;
  switch (profile.format) {
    case "anthropic":
      controls = claudeControls("anthropic", model, entry);
      break;
    case "bedrock":
      // Bedrock's Converse API takes Claude's thinking settings; other
      // Bedrock models have none
      controls = isClaude(model)
        ? claudeControls("bedrock", model, entry)
        : { ...noControls("bedrock"), maxContextLength: promptLimit(entry) };
      break;
    case "openai":
    case "azure": {
      // Azure also deploys Claude, DeepSeek and others, whose reasoning
      // doesn't take OpenAI's reasoning_effort: only OpenAI's models get
      // these controls there, as before the catalog
      const openAIModel =
        profile.format === "openai" ||
        vendorCatalogProvider(model) === "openai";
      const reasons = !openAIModel
        ? false
        : entry
          ? !!entry.reasoning
          : isResponsesModel(baseModelName(model));
      controls = reasons
        ? openAIControls(profile.format, model, entry)
        : {
            ...noControls(profile.format, !entry),
            fast: profile.format === "openai" && !!entry?.fast,
            maxContextLength: promptLimit(entry),
          };
      break;
    }
    case "openrouter":
      controls = openRouterControls(model, entry);
      break;
    case "deepseek":
      controls = deepSeekControls(model, entry);
      break;
    case "moonshot":
      controls = moonshotControls(model, entry);
      break;
    case "gemini":
      controls = geminiControls(model, entry);
      break;
    case "xai":
      controls = xaiControls(model, entry);
      break;
    case "generic":
      controls = genericControls(identity, entry);
      break;
  }

  // OneProvider's -thinking ids always think
  if (profile.thinkingAlwaysOn && controls.thinkingModes.includes("off")) {
    controls = {
      ...controls,
      thinkingModes: controls.thinkingModes.filter((mode) => mode !== "off"),
      thinkingUnavailable: {
        ...controls.thinkingUnavailable,
        off: "This -thinking model always thinks. Pick the model without -thinking to turn it off.",
      },
      defaultThinking: "shown",
    };
  }
  return controls;
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
      if (thinking === "off") {
        fields.thinking = { type: "disabled" };
        // OneProvider doesn't always honor `thinking` alone: a request with
        // tool calls in its history still streamed reasoning. It does honor
        // `reasoning_effort: "none"`, so Off sends both there. DeepSeek's own
        // API is left with its documented switch.
        if (
          identity.provider === ONEPROVIDER_PROVIDER ||
          isOneProviderBase(identity.apiBase)
        ) {
          fields.reasoning_effort = "none";
        }
      }
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
  return effort ? (EFFORT_LABELS[effort] ?? effort) : "Not sent";
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
 * the model (its own limit, or the configured or default context length),
 * and the configured window itself, so the current choice is always one of
 * them (a configured 8K is offered next to the steps)
 */
export function getContextOptions(
  maxContextLength: number | undefined,
  configuredContextLength: number,
): number[] {
  const max = Math.max(maxContextLength ?? 0, configuredContextLength);
  const steps = CONTEXT_STEPS.filter((step) => step < max);
  return [...new Set([...steps, configuredContextLength, max])].sort(
    (a, b) => a - b,
  );
}
