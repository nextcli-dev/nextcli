import type { ModelConfig } from "@nextcli/config-yaml";
import {
  clampEffort,
  effectiveThinkingMode,
  effortLabel,
  formatContextLength,
  getContextOptions as contextOptionsFor,
  getControlsFormat,
  getModelControls,
  type ModelControls,
  type ModelIdentity,
  thinkingLabel,
  type ThinkingMode,
} from "@nextcli/openai-adapters";
import { GlobalContext } from "core/util/GlobalContext.js";

import { logger } from "./logger.js";

/** Settings chosen in the model menu (experimental), per model */
export interface CliModelSettings {
  /** Effort level, or undefined for the provider default */
  effort?: string;
  /**
   * Thinking mode: off (no thinking tokens), hidden or shown. Shared with
   * the IDE extensions' model menu
   */
  thinking?: ThinkingMode;
  /**
   * Request and show readable reasoning. On unless turned off, except for
   * OpenAI, where readable summaries can need a verified organization
   */
  showThinking?: boolean;
  /** Fast or priority mode, where the model has one */
  fast?: boolean;
  /** Context window the CLI plans for (compaction, validation) */
  contextLength?: number;
}

export function modelIdentity(model: ModelConfig): ModelIdentity {
  return {
    provider: model.provider,
    model: model.model,
    apiBase: model.apiBase,
    reasoningConfigured:
      model.defaultCompletionOptions?.reasoning !== undefined ||
      !!model.defaultCompletionOptions?.reasoningEffort,
  };
}

export function modelSettingsKey(model: ModelConfig): string {
  return `${model.provider}/${model.model}`;
}

export function getModelControlsFor(model: ModelConfig): ModelControls {
  return getModelControls(modelIdentity(model));
}

type StoredSettings = Record<string, CliModelSettings>;

/** Read once per run, then kept in step with updateModelSettings */
let storedSettings: StoredSettings | undefined;

function readAllStoredSettings(): StoredSettings {
  if (!storedSettings) {
    try {
      storedSettings = new GlobalContext().get("cliModelSettings") ?? {};
    } catch (error) {
      logger.debug("Could not read model settings", { error });
      storedSettings = {};
    }
  }
  return storedSettings;
}

function readStoredSettings(model: ModelConfig): CliModelSettings {
  return readAllStoredSettings()[modelSettingsKey(model)] ?? {};
}

/** For tests: forget the cached settings */
export function resetModelSettingsCache(): void {
  storedSettings = undefined;
}

/**
 * Show thinking is on by default, except on OpenAI: its reasoning summaries
 * fail for organizations that aren't verified, so they're opt-in there.
 */
function defaultShowThinking(model: ModelConfig): boolean {
  return getControlsFormat(modelIdentity(model)) !== "openai";
}

/**
 * The effective settings for a model: the model menu, then the config's `reasoningEffort` (or `reasoning: true`, which
 * means medium).
 */
export function getModelSettings(model: ModelConfig): CliModelSettings {
  const stored = readStoredSettings(model);
  return {
    ...stored,
    effort:
      stored.effort ??
      model.defaultCompletionOptions?.reasoningEffort ??
      (model.defaultCompletionOptions?.reasoning ? "medium" : undefined),
    showThinking:
      stored.thinking === undefined
        ? (stored.showThinking ?? defaultShowThinking(model))
        : stored.thinking === "shown",
  };
}

/**
 * The thinking mode a request runs with: the one chosen in a model menu,
 * else the model's default (Claude before 5 thinks once an effort is set)
 */
export function effectiveThinking(
  model: ModelConfig,
): ThinkingMode | undefined {
  const stored = readStoredSettings(model);
  return effectiveThinkingMode(getModelControlsFor(model), {
    effort: getModelSettings(model).effort,
    thinking: stored.thinking,
    // Only a saved value: the filled-in default isn't a choice
    showThinking: stored.showThinking,
  });
}

/**
 * Settings for buildModelControlFields: the thinking mode only when one was
 * chosen, so requests for untouched models keep the provider's default
 */
export function requestControlSettings(model: ModelConfig): CliModelSettings {
  const settings = getModelSettings(model);
  const chosen = readStoredSettings(model).thinking;
  return {
    effort: settings.effort,
    fast: settings.fast,
    ...(chosen === undefined
      ? { showThinking: settings.showThinking }
      : { thinking: chosen }),
  };
}

/** Saves menu changes for a model. A value of undefined clears that setting */
export function updateModelSettings(
  model: ModelConfig,
  patch: Partial<CliModelSettings>,
): CliModelSettings {
  const key = modelSettingsKey(model);
  const all = readAllStoredSettings();
  const next: CliModelSettings = { ...all[key], ...patch };
  for (const name of Object.keys(next) as (keyof CliModelSettings)[]) {
    if (next[name] === undefined) delete next[name];
  }
  storedSettings = { ...all, [key]: next };
  try {
    new GlobalContext().update("cliModelSettings", storedSettings);
  } catch (error) {
    logger.warn("Could not save model settings", { error });
  }
  return getModelSettings(model);
}

/**
 * The effort level actually sent: the chosen level, or the nearest level the
 * model supports
 */
export function effectiveEffort(model: ModelConfig): string | undefined {
  return clampEffort(
    getModelControlsFor(model).efforts,
    getModelSettings(model).effort,
  );
}

/** Whether reasoning should be shown for the model */
export function shouldShowReasoning(model: ModelConfig | null | undefined) {
  // Off sends nothing to show, and a configured budget can still think
  return !model || effectiveThinking(model) !== "hidden";
}

export { effortLabel, formatContextLength, thinkingLabel };

/**
 * Context windows to offer: standard steps up to the largest one known for
 * the model (its own limit, or the configured or default context length).
 */
export function getContextOptions(
  model: ModelConfig,
  defaultContextLength: number,
): number[] {
  return contextOptionsFor(
    getModelControlsFor(model).maxContextLength,
    model.defaultCompletionOptions?.contextLength ?? defaultContextLength,
  );
}

/** Short label for the status bar, for example "claude-opus-5-5 · High" */
export function modelStatusLabel(model: ModelConfig): string {
  const settings = getModelSettings(model);
  const controls = getModelControlsFor(model);
  const parts = [model.name || model.model];
  const effort = effectiveEffort(model);
  if (effort) {
    parts.push(effortLabel(effort));
  }
  if (settings.fast && controls.fast) {
    parts.push("Fast");
  }
  if (readStoredSettings(model).thinking === "off") {
    parts.push("No thinking");
  }
  return parts.join(" · ");
}
