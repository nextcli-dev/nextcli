import { stringify } from "yaml";

import {
  getPresetApiKeyFromEnv,
  getProviderPreset,
  PROVIDER_PRESETS,
} from "./providerPresets.js";

export interface EnvProviderConfig {
  providerId: string;
  /** Where the settings came from, e.g. "OPENAI_API_KEY", for logs and errors */
  source: string;
  yaml: string;
}

/** The variables listed in errors when no config can be built */
export const SUPPORTED_ENV_VARS = [
  ...PROVIDER_PRESETS.flatMap((preset) =>
    preset.envKey ? [preset.envKey] : [],
  ),
  "NEXTCLI_PROVIDER (with NEXTCLI_MODEL, NEXTCLI_MODEL_API_KEY, NEXTCLI_MODEL_BASE_URL)",
];

/**
 * Builds a config from environment variables, for running without a
 * config.yaml (e.g. `cn -p` in CI). The config only exists in memory.
 *
 * NEXTCLI_PROVIDER selects a provider explicitly (anthropic, openai, deepseek,
 * openrouter, oneprovider, openai-compatible, ollama), with NEXTCLI_MODEL,
 * NEXTCLI_MODEL_API_KEY and NEXTCLI_MODEL_BASE_URL. Otherwise the first of
 * ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, OPENROUTER_API_KEY and
 * ONEPROVIDER_API_KEY (or ONEPROVIDER_KEY) picks the provider, and
 * NEXTCLI_MODEL can still override its default model.
 *
 * Throws when NEXTCLI_PROVIDER is set but incomplete, so a typo is not silently ignored.
 */
export function resolveEnvProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): EnvProviderConfig | undefined {
  const model = env.NEXTCLI_MODEL?.trim() || undefined;
  const apiBase = env.NEXTCLI_MODEL_BASE_URL?.trim() || undefined;

  const explicitProvider = env.NEXTCLI_PROVIDER?.trim();
  if (explicitProvider) {
    const preset = getProviderPreset(explicitProvider);
    if (!preset) {
      throw new Error(
        `Unknown NEXTCLI_PROVIDER "${explicitProvider}". Use one of: ${PROVIDER_PRESETS.map((p) => p.id).join(", ")}.`,
      );
    }
    const apiKey =
      env.NEXTCLI_MODEL_API_KEY?.trim() ||
      getPresetApiKeyFromEnv(preset, env)?.value ||
      undefined;
    if (preset.needsApiKey && !apiKey) {
      throw new Error(
        `NEXTCLI_PROVIDER=${preset.id} needs NEXTCLI_MODEL_API_KEY${preset.envKey ? ` or ${preset.envKey}` : ""}.`,
      );
    }
    if (preset.needsApiBaseAndModel && (!apiBase || !model)) {
      throw new Error(
        `NEXTCLI_PROVIDER=${preset.id} needs NEXTCLI_MODEL_BASE_URL and NEXTCLI_MODEL.`,
      );
    }
    return {
      providerId: preset.id,
      source: "NEXTCLI_PROVIDER",
      yaml: toConfigYaml(preset.models({ apiKey, model, apiBase })),
    };
  }

  for (const preset of PROVIDER_PRESETS) {
    const found = getPresetApiKeyFromEnv(preset, env);
    if (found) {
      return {
        providerId: preset.id,
        source: found.name,
        yaml: toConfigYaml(preset.models({ apiKey: found.value, model })),
      };
    }
  }

  return undefined;
}

function toConfigYaml(models: object[]): string {
  return stringify({
    name: "Environment Config",
    version: "1.0.0",
    schema: "v1",
    models,
  });
}
