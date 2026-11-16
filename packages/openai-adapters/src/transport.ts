import { hostOf, isClaude } from "@nextcli/llm-info";

import { isOfficialOpenAI } from "./modelProfile.js";

/**
 * Which code sends a model's chat requests: the AI SDK (apis/AiSdk.ts) or
 * the provider's own adapter in apis/. See release-plans/ai-sdk-migration.md.
 */
export type Transport = "ai-sdk" | "legacy";

/** The AI SDK provider that builds a route's requests */
export type AiSdkFactory = "openai-compatible" | "anthropic" | "openai";

export interface AiSdkRoute {
  factory: AiSdkFactory;
  /**
   * Assistant messages get an empty `reasoning_content` when they have
   * none, as the DeepSeek adapter does (util.ts addEmptyReasoningContent)
   */
  emptyReasoningContent?: boolean;
}

/**
 * How the AI SDK sends a model's chat requests on its endpoint, or
 * undefined when that model stays on its provider's own adapter. Each route
 * sends what the provider's own adapter sends for the same request; the
 * parity tests (test/transportParity.vitest.ts) hold them to it.
 */
export function aiSdkRoute({
  provider,
  model,
  apiBase,
}: {
  provider: string;
  model: string;
  apiBase?: string;
}): AiSdkRoute | undefined {
  switch (provider) {
    case "openai":
      // A custom endpoint (a bridge, vLLM, a gateway such as OneProvider)
      // takes the request as it is; OpenAI's own API comes later
      return isOfficialOpenAI(apiBase)
        ? undefined
        : { factory: "openai-compatible" };
    case "oneprovider":
      // Claude goes through OneProvider's Anthropic Messages API
      return isClaude(model) ? undefined : { factory: "openai-compatible" };
    case "deepseek":
      // DeepSeek through a gateway; DeepSeek's own API, with its FIM, stays
      return apiBase && hostOf(apiBase) !== "api.deepseek.com"
        ? { factory: "openai-compatible", emptyReasoningContent: true }
        : undefined;
    default:
      return undefined;
  }
}

/** Providers with at least one AI-SDK route */
const MIGRATED_PROVIDERS = new Set(["openai", "oneprovider", "deepseek"]);

/** An environment flag: set, and not empty, "0" or "false" */
function envFlag(value: string | undefined): boolean {
  return (
    value !== undefined && !["", "0", "false"].includes(value.toLowerCase())
  );
}

/**
 * The transport for a model config. A provider without AI-SDK routes always
 * keeps its own adapter. Otherwise the model's `transport` wins, then the
 * NEXTCLI_USE_AI_SDK opt-in (CONTINUE_USE_AI_SDK is its old name, still
 * read). Without either, requests keep the provider's own adapter.
 */
export function selectTransport(
  config: { provider: string; transport?: Transport },
  env: NodeJS.ProcessEnv = process.env,
): Transport {
  if (!MIGRATED_PROVIDERS.has(config.provider)) {
    return "legacy";
  }
  if (config.transport) {
    return config.transport;
  }
  return envFlag(env.NEXTCLI_USE_AI_SDK ?? env.CONTINUE_USE_AI_SDK)
    ? "ai-sdk"
    : "legacy";
}
