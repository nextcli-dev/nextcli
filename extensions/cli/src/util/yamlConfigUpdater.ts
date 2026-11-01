import { parseDocument } from "yaml";

import {
  getProviderPreset,
  type ProviderPreset,
  type ProviderPresetOptions,
} from "./providerPresets.js";

export interface ModelConfig {
  name: string;
  provider: string;
  model: string;
  apiKey?: string;
  apiBase?: string;
  roles: string[];
  defaultCompletionOptions?: {
    contextLength: number;
    maxTokens: number;
  };
  capabilities?: string[];
}

export interface ConfigStructure {
  name: string;
  version: string;
  schema: string;
  models: ModelConfig[];
}

// Model ids onboarding wrote in earlier releases, replaced when onboarding runs again
const PREVIOUS_ONBOARDING_MODELS: Record<string, string[]> = {
  anthropic: ["claude-sonnet-4-6", "claude-opus-4-6"],
};

function isManagedModel(model: any, newModels: ModelConfig[]): boolean {
  if (!model || typeof model !== "object") {
    return false;
  }
  const provider = newModels[0]?.provider;
  // Drop legacy slug-based blocks (e.g. `uses: anthropic/claude-sonnet-4-6`)...
  if (
    provider &&
    typeof model.uses === "string" &&
    model.uses.startsWith(`${provider}/`)
  ) {
    return true;
  }
  // ...as well as models onboarding writes for this provider, now or before
  return (
    model.provider === provider &&
    (newModels.some((m) => m.model === model.model) ||
      (PREVIOUS_ONBOARDING_MODELS[provider] ?? []).includes(model.model))
  );
}

function newConfigYaml(models: ModelConfig[]): string {
  const defaultConfig: ConfigStructure = {
    name: "Main Config",
    version: "1.0.0",
    schema: "v1",
    models,
  };

  const doc = parseDocument("");
  Object.keys(defaultConfig).forEach((key) =>
    doc.set(key, (defaultConfig as any)[key]),
  );
  return doc.toString();
}

/**
 * Adds a provider's onboarding models to a YAML config string, replacing the
 * ones onboarding added before and keeping all other models and comments.
 * This is a pure function that takes a YAML string and returns a modified YAML string.
 *
 * @param yamlContent - The original YAML content as a string (can be empty)
 * @param preset - The provider chosen during onboarding
 * @param options - API key, and model and base URL where the provider needs them
 * @returns The updated YAML content as a string with comments preserved
 */
export function upsertProviderModelsInYaml(
  yamlContent: string,
  preset: ProviderPreset,
  options: ProviderPresetOptions,
): string {
  const newModels = preset.models(options);

  try {
    const doc = parseDocument(yamlContent);

    // If document is empty or has no content, create a new config
    if (!doc.contents || doc.contents === null) {
      return newConfigYaml(newModels);
    }

    // Convert to JS, filter models, and recreate
    const config = doc.toJS() as any;

    // Make sure models array exists
    if (!config.models || !Array.isArray(config.models)) {
      config.models = [];
    }

    config.models = config.models.filter(
      (model: any) => !isManagedModel(model, newModels),
    );
    config.models.push(...newModels);

    // Update the models array while preserving comments and structure
    doc.set("models", config.models);

    return doc.toString();
  } catch {
    // If parsing fails completely, create a new config
    return newConfigYaml(newModels);
  }
}

/**
 * Updates or adds the Anthropic onboarding models in a YAML string.
 *
 * @param yamlContent - The original YAML content as a string (can be empty)
 * @param apiKey - The Anthropic API key to set
 * @returns The updated YAML content as a string with comments preserved
 */
export function updateAnthropicModelInYaml(
  yamlContent: string,
  apiKey: string,
): string {
  return upsertProviderModelsInYaml(
    yamlContent,
    getProviderPreset("anthropic")!,
    { apiKey },
  );
}
