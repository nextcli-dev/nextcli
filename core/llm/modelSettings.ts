import {
  chosenThinkingMode,
  clampEffort,
  effectiveThinkingMode,
  type ThinkingMode,
} from "@nextcli/openai-adapters";

import type {
  BaseCompletionOptions,
  ILLM,
  SerializedModelControls,
} from "../index.js";
import type { GlobalContext } from "../util/GlobalContext.js";

/**
 * Model menu settings saved for one model. They're stored in GlobalContext
 * under `cliModelSettings`, keyed by `provider/model`, so the CLI's /model
 * menu and the IDE extensions share them.
 */
export interface StoredModelSettings {
  effort?: string;
  thinking?: ThinkingMode;
  /** Older CLI setting, read when `thinking` isn't set */
  showThinking?: boolean;
  fast?: boolean;
  contextLength?: number;
}

/** A change to the stored settings. null clears a setting */
export type ModelSettingsPatch = {
  [K in keyof StoredModelSettings]?: StoredModelSettings[K] | null;
};

/** The settings a chat request runs with, after defaults and limits */
export interface ResolvedModelSettings {
  key: string;
  /** Effort level sent, already clamped to the model's levels */
  effort?: string;
  /** Thinking mode sent; undefined when the model has no thinking modes */
  thinking?: ThinkingMode;
  fast: boolean;
  contextLength: number;
  /** What's saved, to tell a default from a choice */
  stored: StoredModelSettings;
}

export interface ResolveOptions {
  /**
   * Treat "thinking on" as the default for models that only think when
   * asked (Claude before 5). The IDE extensions have always had thinking on
   * by default; the CLI keeps it off until an effort is set.
   */
  thinkingOnByDefault?: boolean;
}

export function modelSettingsKey(model: {
  provider: string;
  model: string;
}): string {
  return `${model.provider}/${model.model}`;
}

/**
 * The settings a model runs with: the stored menu choices, then the
 * config's `reasoningEffort` and `reasoning`, then the model's defaults.
 */
export function resolveModelSettings(
  key: string,
  controls: SerializedModelControls,
  stored: StoredModelSettings,
  completionOptions: BaseCompletionOptions | undefined,
  options: ResolveOptions = {},
): ResolvedModelSettings {
  const settings = {
    effort: stored.effort ?? completionOptions?.reasoningEffort,
    thinking: stored.thinking,
    showThinking: stored.showThinking,
    fast: stored.fast,
  };

  let thinking: ThinkingMode | undefined = chosenThinkingMode(
    controls,
    settings,
  );
  if (!thinking) {
    if (
      completionOptions?.reasoning === false &&
      controls.thinkingModes.includes("off")
    ) {
      thinking = "off";
    } else {
      thinking = effectiveThinkingMode(controls, settings);
      if (
        thinking === "off" &&
        (options.thinkingOnByDefault || completionOptions?.reasoning) &&
        controls.thinkingModes.includes("shown")
      ) {
        thinking = "shown";
      }
    }
  }

  const effort =
    thinking === "off" && controls.effortNeedsThinking
      ? undefined
      : clampEffort(controls.efforts, settings.effort);
  const maxContext = Math.max(
    controls.defaultContextLength,
    ...controls.contextOptions,
  );
  const contextLength =
    stored.contextLength && stored.contextLength <= maxContext
      ? stored.contextLength
      : controls.defaultContextLength;

  return {
    key,
    ...(effort && { effort }),
    ...(thinking && { thinking }),
    fast: !!stored.fast && controls.fast,
    contextLength,
    stored,
  };
}

export function readStoredModelSettings(
  globalContext: GlobalContext,
): Record<string, StoredModelSettings> {
  try {
    return globalContext.get("cliModelSettings") ?? {};
  } catch {
    return {};
  }
}

/** Saves a change for one model and returns that model's stored settings */
export function updateStoredModelSettings(
  globalContext: GlobalContext,
  key: string,
  patch: ModelSettingsPatch,
): StoredModelSettings {
  const all = readStoredModelSettings(globalContext);
  const next: Record<string, unknown> = { ...all[key] };
  for (const [name, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      delete next[name];
    } else {
      next[name] = value;
    }
  }
  globalContext.update("cliModelSettings", {
    ...all,
    [key]: next as StoredModelSettings,
  });
  return next as StoredModelSettings;
}

/** Resolved settings for each model, keyed by modelSettingsKey */
export function resolveSettingsForModels(
  models: ILLM[],
  stored: Record<string, StoredModelSettings>,
  options: ResolveOptions = {},
): Record<string, ResolvedModelSettings> {
  const result: Record<string, ResolvedModelSettings> = {};
  for (const llm of models) {
    const key = modelSettingsKey({
      provider: llm.providerName,
      model: llm.model,
    });
    if (result[key]) continue;
    result[key] = resolveModelSettings(
      key,
      llm.getModelControls(),
      stored[key] ?? {},
      llm.completionOptions,
      options,
    );
  }
  return result;
}
