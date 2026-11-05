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
  /devstral/,
  /glm/,
  /minimax/,
];

/**
 * Determines if a model is recommended for use with `cn`.
 *
 * A model is capable when any source says it can call tools: the config
 * (`capabilities: [tool_use]`), the provider tool-support rules shared with
 * the IDE extensions, the recommended agent models, or the name patterns.
 */
export function isModelCapable(
  provider: string,
  name: string,
  model?: string,
  capabilities?: string[],
): boolean {
  if (capabilities?.includes("tool_use")) {
    return true;
  }

  const providerSupportsTools = PROVIDER_TOOL_SUPPORT[provider];
  if (providerSupportsTools?.(model ?? name)) {
    return true;
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
