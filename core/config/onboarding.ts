import { ConfigYaml } from "@nextcli/config-yaml";

export const LOCAL_ONBOARDING_PROVIDER_TITLE = "Ollama";
export const LOCAL_ONBOARDING_FIM_MODEL = "qwen2.5-coder:1.5b-base";
export const LOCAL_ONBOARDING_FIM_TITLE = "Qwen2.5-Coder 1.5B";
export const LOCAL_ONBOARDING_CHAT_MODEL = "llama3.1:8b";
export const LOCAL_ONBOARDING_CHAT_TITLE = "Llama 3.1 8B";
export const LOCAL_ONBOARDING_EMBEDDINGS_MODEL = "nomic-embed-text:latest";
export const LOCAL_ONBOARDING_EMBEDDINGS_TITLE = "Nomic Embed";

type OnboardingModel = NonNullable<ConfigYaml["models"]>[number];

// These model definitions are inlined copies of the corresponding Continue Hub
// blocks (e.g. anthropic/claude-sonnet-4-6) that onboarding previously resolved
// via `uses:` slugs. Since Hub/slug resolution has been removed, we reproduce
// the exact block contents here, with `apiKey` substituted for the block's
// `${{ inputs.*_API_KEY }}` placeholder. Keep these in sync with the Hub blocks.
// Keep in sync with extensions/cli/src/util/providerPresets.ts (ids checked 2026-11-04)
const ANTHROPIC_ONBOARDING_MODELS = (apiKey: string): OnboardingModel[] => [
  {
    name: "Claude Sonnet 5.5",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    apiKey,
    roles: ["chat", "edit", "apply"],
    defaultCompletionOptions: { contextLength: 1000000, maxTokens: 64000 },
    capabilities: ["tool_use", "image_input"],
  },
  {
    name: "Claude Opus 5.5",
    provider: "anthropic",
    model: "claude-opus-5-5",
    apiKey,
    roles: ["chat", "edit", "apply"],
    defaultCompletionOptions: { contextLength: 1000000, maxTokens: 64000 },
    capabilities: ["tool_use", "image_input"],
  },
];

const OPENAI_ONBOARDING_MODELS = (apiKey: string): OnboardingModel[] => [
  {
    name: "GPT-5.5",
    provider: "openai",
    model: "gpt-5.5",
    apiKey,
    roles: ["chat", "edit", "apply"],
    defaultCompletionOptions: { contextLength: 1050000, maxTokens: 64000 },
    capabilities: ["tool_use", "image_input"],
  },
  {
    name: "GPT-5.4 mini",
    provider: "openai",
    model: "gpt-5.4-mini",
    apiKey,
    roles: ["chat", "edit", "apply"],
    defaultCompletionOptions: { contextLength: 400000, maxTokens: 64000 },
    capabilities: ["tool_use", "image_input"],
  },
];

const GEMINI_ONBOARDING_MODELS = (apiKey: string): OnboardingModel[] => [
  {
    name: "Gemini 4 Argon",
    provider: "gemini",
    model: "gemini-4-argon",
    apiKey,
    roles: ["chat", "edit", "apply"],
    capabilities: ["tool_use", "image_input"],
  },
  {
    name: "Gemini 3.8 Flash",
    provider: "gemini",
    model: "gemini-3.8-flash",
    apiKey,
    roles: ["chat", "edit", "apply"],
    capabilities: ["tool_use", "image_input"],
  },
];

/**
 * We set the "best" chat + autocopmlete models by default
 * whenever a user doesn't have a config.json
 */
export function setupBestConfig(config: ConfigYaml): ConfigYaml {
  return {
    ...config,
    models: config.models,
  };
}

export function setupLocalConfig(config: ConfigYaml): ConfigYaml {
  return {
    ...config,
    models: [
      {
        name: LOCAL_ONBOARDING_CHAT_TITLE,
        provider: "ollama",
        model: LOCAL_ONBOARDING_CHAT_MODEL,
        roles: ["chat", "edit", "apply"],
      },
      {
        name: LOCAL_ONBOARDING_FIM_TITLE,
        provider: "ollama",
        model: LOCAL_ONBOARDING_FIM_MODEL,
        roles: ["autocomplete"],
      },
      {
        name: LOCAL_ONBOARDING_EMBEDDINGS_TITLE,
        provider: "ollama",
        model: LOCAL_ONBOARDING_EMBEDDINGS_MODEL,
        roles: ["embed"],
      },
      ...(config.models ?? []),
    ],
  };
}

export function setupQuickstartConfig(config: ConfigYaml): ConfigYaml {
  return config;
}

export function setupProviderConfig(
  config: ConfigYaml,
  provider: string,
  apiKey: string,
): ConfigYaml {
  let newModels: OnboardingModel[];

  switch (provider) {
    case "openai":
      newModels = OPENAI_ONBOARDING_MODELS(apiKey);
      break;
    case "anthropic":
      newModels = ANTHROPIC_ONBOARDING_MODELS(apiKey);
      break;
    case "gemini":
      newModels = GEMINI_ONBOARDING_MODELS(apiKey);
      break;
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }

  const existingModels = config.models ?? [];

  const isSameModel = (m: OnboardingModel, n: OnboardingModel) =>
    "provider" in m &&
    "provider" in n &&
    m.provider === n.provider &&
    m.model === n.model;

  // Update API key on existing models; add new entries for any missing models
  const updatedModels = existingModels.map((m) => {
    const match = newModels.find((n) => isSameModel(m, n));
    return match ? { ...m, apiKey } : m;
  });
  const modelsToAdd = newModels.filter(
    (n) => !existingModels.some((m) => isSameModel(m, n)),
  );

  return { ...config, models: [...updatedModels, ...modelsToAdd] };
}
