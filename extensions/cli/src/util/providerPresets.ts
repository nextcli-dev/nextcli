import type { ModelConfig } from "./yamlConfigUpdater.js";

export type ProviderId =
  | "anthropic"
  | "openai"
  | "deepseek"
  | "openrouter"
  | "oneprovider"
  | "openai-compatible"
  | "ollama";

export interface ProviderPresetOptions {
  apiKey?: string;
  model?: string;
  apiBase?: string;
}

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  /** Environment variable that holds the key, checked in this table's order */
  envKey?: string;
  /** Other names the same key is accepted under */
  envKeyAliases?: string[];
  needsApiKey: boolean;
  /** openai-compatible needs a base URL and a model name */
  needsApiBaseAndModel: boolean;
  defaultModel?: string;
  validateApiKey(apiKey: string): string | undefined;
  models(options: ProviderPresetOptions): ModelConfig[];
}

function requireNonEmpty(apiKey: string): string | undefined {
  return apiKey.trim() ? undefined : "API key is required";
}

function requirePrefix(prefix: string) {
  return (apiKey: string): string | undefined => {
    if (!apiKey.trim()) {
      return "API key is required";
    }
    if (!apiKey.startsWith(prefix)) {
      return `API key must start with "${prefix}"`;
    }
    if (apiKey.length <= prefix.length) {
      return "API key is too short";
    }
    return undefined;
  };
}

const CHAT_ROLES = ["chat", "edit", "apply"];

// Model ids and limits were checked against each provider's model list on 2026-11-01.
// Keep the Anthropic and OpenAI defaults in sync with core/config/onboarding.ts.
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    needsApiKey: true,
    needsApiBaseAndModel: false,
    defaultModel: "claude-sonnet-5-5",
    validateApiKey: requirePrefix("sk-ant-"),
    models: ({ apiKey, model }) =>
      model
        ? [customModel("anthropic", model, apiKey)]
        : [
            {
              name: "Claude Sonnet 5.5",
              provider: "anthropic",
              model: "claude-sonnet-5-5",
              apiKey,
              roles: CHAT_ROLES,
              defaultCompletionOptions: {
                contextLength: 1000000,
                maxTokens: 64000,
              },
              capabilities: ["tool_use", "image_input"],
            },
            {
              name: "Claude Opus 5.5",
              provider: "anthropic",
              model: "claude-opus-5-5",
              apiKey,
              roles: CHAT_ROLES,
              defaultCompletionOptions: {
                contextLength: 1000000,
                maxTokens: 64000,
              },
              capabilities: ["tool_use", "image_input"],
            },
          ],
  },
  {
    id: "openai",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    needsApiKey: true,
    needsApiBaseAndModel: false,
    defaultModel: "gpt-5.5",
    validateApiKey: requirePrefix("sk-"),
    models: ({ apiKey, model }) =>
      model
        ? [customModel("openai", model, apiKey)]
        : [
            {
              name: "GPT-5.5",
              provider: "openai",
              model: "gpt-5.5",
              apiKey,
              roles: CHAT_ROLES,
              defaultCompletionOptions: {
                contextLength: 1050000,
                maxTokens: 64000,
              },
              capabilities: ["tool_use", "image_input"],
            },
            {
              name: "GPT-5.4 mini",
              provider: "openai",
              model: "gpt-5.4-mini",
              apiKey,
              roles: CHAT_ROLES,
              defaultCompletionOptions: {
                contextLength: 400000,
                maxTokens: 64000,
              },
              capabilities: ["tool_use", "image_input"],
            },
          ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    needsApiKey: true,
    needsApiBaseAndModel: false,
    defaultModel: "deepseek-v4-pro",
    validateApiKey: requirePrefix("sk-"),
    models: ({ apiKey, model }) => [
      customModel("deepseek", model ?? "deepseek-v4-pro", apiKey, "DeepSeek"),
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    needsApiKey: true,
    needsApiBaseAndModel: false,
    // OpenRouter picks a model per request unless one is given
    defaultModel: "openrouter/auto",
    validateApiKey: requirePrefix("sk-or-"),
    models: ({ apiKey, model }) => [
      customModel(
        "openrouter",
        model ?? "openrouter/auto",
        apiKey,
        "OpenRouter",
      ),
    ],
  },
  {
    // https://oneprovider.dev: Claude through its Anthropic Messages API,
    // every other model through its OpenAI-compatible API, with one key
    id: "oneprovider",
    label: "OneProvider (Claude, GPT, DeepSeek, Gemini and more)",
    envKey: "ONEPROVIDER_API_KEY",
    envKeyAliases: ["ONEPROVIDER_KEY"],
    needsApiKey: true,
    needsApiBaseAndModel: false,
    defaultModel: "claude-sonnet-5-5",
    validateApiKey: requirePrefix("sk-"),
    models: ({ apiKey, model }) =>
      model
        ? [customModel("oneprovider", model, apiKey, "OneProvider")]
        : [
            {
              name: "OneProvider Claude Sonnet 5.5",
              provider: "oneprovider",
              model: "claude-sonnet-5-5",
              apiKey,
              roles: CHAT_ROLES,
              defaultCompletionOptions: {
                contextLength: 1000000,
                maxTokens: 64000,
              },
              capabilities: ["tool_use", "image_input"],
            },
            customModel(
              "oneprovider",
              "deepseek-v4-pro",
              apiKey,
              "OneProvider",
            ),
          ],
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible gateway",
    needsApiKey: true,
    needsApiBaseAndModel: true,
    validateApiKey: requireNonEmpty,
    models: ({ apiKey, model, apiBase }) => [
      { ...customModel("openai", model ?? "", apiKey), apiBase },
    ],
  },
  {
    id: "ollama",
    label: "Ollama (local, no key)",
    needsApiKey: false,
    needsApiBaseAndModel: false,
    defaultModel: "llama3.1:8b",
    validateApiKey: () => undefined,
    models: ({ model, apiBase }) => [
      {
        ...customModel("ollama", model ?? "llama3.1:8b", undefined, "Ollama"),
        ...(apiBase ? { apiBase } : {}),
      },
    ],
  },
];

function customModel(
  provider: string,
  model: string,
  apiKey: string | undefined,
  namePrefix?: string,
): ModelConfig {
  return {
    name: namePrefix ? `${namePrefix} ${model}` : model,
    provider,
    model,
    ...(apiKey ? { apiKey } : {}),
    roles: CHAT_ROLES,
    capabilities: ["tool_use"],
  };
}

/**
 * The preset's API key from the environment, under its name or an alias,
 * with the variable it came from
 */
export function getPresetApiKeyFromEnv(
  preset: ProviderPreset,
  env: NodeJS.ProcessEnv,
): { name: string; value: string } | undefined {
  for (const name of [preset.envKey, ...(preset.envKeyAliases ?? [])]) {
    const value = name ? env[name]?.trim() : undefined;
    if (name && value) return { name, value };
  }
  return undefined;
}

export function getProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}
