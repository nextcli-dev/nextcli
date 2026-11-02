import type { ModelConfig } from "@nextcli/config-yaml";
import {
  clampEffort,
  getControlsFormat,
  getModelControls,
  type ModelControls,
  type ModelIdentity,
} from "@nextcli/openai-adapters";
import { GlobalContext } from "core/util/GlobalContext.js";

import { logger } from "./logger.js";

/** Settings chosen in the model menu (experimental), per model */
export interface CliModelSettings {
  /** Effort level, or undefined for the provider default */
  effort?: string;
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

/** An effort level set for this run, for example with --effort */
let sessionEffort: string | undefined;

export function setSessionEffort(effort: string | undefined): void {
  sessionEffort = effort;
}

export function modelIdentity(model: ModelConfig): ModelIdentity {
  return {
    provider: model.provider,
    model: model.model,
    apiBase: model.apiBase,
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
  sessionEffort = undefined;
}

/**
 * Show thinking is on by default, except on OpenAI: its reasoning summaries
 * fail for organizations that aren't verified, so they're opt-in there.
 */
function defaultShowThinking(model: ModelConfig): boolean {
  return getControlsFormat(modelIdentity(model)) !== "openai";
}

/**
 * The effective settings for a model: the --effort flag, then the model
 * menu, then the config's `reasoningEffort` (or `reasoning: true`, which
 * means medium).
 */
export function getModelSettings(model: ModelConfig): CliModelSettings {
  const stored = readStoredSettings(model);
  return {
    ...stored,
    effort:
      sessionEffort ??
      stored.effort ??
      model.defaultCompletionOptions?.reasoningEffort ??
      (model.defaultCompletionOptions?.reasoning ? "medium" : undefined),
    showThinking: stored.showThinking ?? defaultShowThinking(model),
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
  if ("effort" in patch) {
    // A menu choice replaces the --effort value for the rest of the run
    sessionEffort = undefined;
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
  return !model || getModelSettings(model).showThinking !== false;
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

export function formatContextLength(tokens: number): string {
  return tokens >= 1_000_000
    ? `${tokens / 1_000_000}M`
    : `${Math.round(tokens / 1000)}K`;
}

const CONTEXT_STEPS = [64_000, 128_000, 200_000, 256_000, 400_000, 1_000_000];

/**
 * Context windows to offer: standard steps up to the largest one known for
 * the model (its own limit, or the configured or default context length).
 */
export function getContextOptions(
  model: ModelConfig,
  defaultContextLength: number,
): number[] {
  const max = Math.max(
    getModelControlsFor(model).maxContextLength ?? 0,
    model.defaultCompletionOptions?.contextLength ?? defaultContextLength,
  );
  const steps = CONTEXT_STEPS.filter((step) => step < max);
  return [...steps, max];
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
  return parts.join(" · ");
}
