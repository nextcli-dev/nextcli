import { catalogToolSupport } from "@nextcli/openai-adapters";
import {
  isRecommendedAgentModel,
  PROVIDER_TOOL_SUPPORT,
} from "core/llm/toolSupport.js";

// Model families known to handle cn's tools, for gateway model ids that no
// provider rule recognises
const CAPABLE_NAME_PATTERNS = [
  /gemini/,
  /claude/,
  /gpt/,
  /o\d/,
  /kimi/,
  /qwen/,
  /llama/,
  /nemotron/,
  /grok/,
  /mistral/,
  // Anchored: these families must start the id or follow a separator
  /(^|[^a-z])devstral/,
  /(^|[^a-z])glm/,
  /(^|[^a-z])minimax/,
];

// Providers whose model ids are free-form (OpenAI-compatible gateways, local
// servers): their tool-support rules only know some ids, so a "no" there
// still lets the name patterns decide
const GENERIC_ENDPOINT_PROVIDERS = new Set([
  "openai",
  "azure",
  "ollama",
  "lmstudio",
]);

/**
 * Determines if a model is recommended for use with `cn`.
 *
 * In order:
 * 1. The config's `capabilities` list, when it has one: `tool_use` in it
 *    decides, as in the IDE extensions (core/config/yaml/models.ts).
 * 2. The provider tool-support rules shared with the IDE extensions. A "no"
 *    is final for a real model id on a provider with its own models (e.g.
 *    openrouter's moonshotai/kimi-k2:free); generic endpoints go on to the
 *    names.
 * 3. For a provider without a rule (Groq, DeepInfra, Fireworks...), the
 *    models.dev catalog of the model's endpoint, for a model id it lists.
 * 4. The recommended agent models and the name patterns.
 */
export function isModelCapable(
  provider: string,
  name: string,
  model?: string,
  capabilities?: string[],
  apiBase?: string,
): boolean {
  if (capabilities) {
    return capabilities.includes("tool_use");
  }

  const providerRule = PROVIDER_TOOL_SUPPORT[provider];
  if (providerRule) {
    if (providerRule(model ?? name)) {
      return true;
    }
    // Rules match model ids, not display names
    if (model && !GENERIC_ENDPOINT_PROVIDERS.has(provider)) {
      return false;
    }
  } else if (model) {
    const fromCatalog = catalogToolSupport({ provider, model, apiBase });
    if (fromCatalog !== undefined) {
      return fromCatalog;
    }
  }

  const names = [name, model]
    .filter((value): value is string => !!value)
    .map((value) => value.toLowerCase());

  return names.some(
    (value) =>
      isRecommendedAgentModel(value) ||
      CAPABLE_NAME_PATTERNS.some((pattern) => pattern.test(value)),
  );
}
