import { hostOf, isClaude } from "@nextcli/llm-info";

import { isOfficialOpenAI } from "./modelProfile.js";

/**
 * Which code sends a model's chat requests: the AI SDK (apis/AiSdk.ts) or
 * the provider's own adapter in apis/. See release-plans/ai-sdk-migration.md.
 */
export type Transport = "ai-sdk" | "legacy";

/** The AI SDK provider that builds a route's requests */
export type AiSdkFactory = "openai-compatible";

export interface AiSdkRoute {
  factory: AiSdkFactory;
  /**
   * Assistant messages get an empty `reasoning_content` when they have
   * none, as the DeepSeek adapter does (util.ts addEmptyReasoningContent)
   */
  emptyReasoningContent?: boolean;
}

/**
 * The route for an endpoint, whatever the model: undefined when the
 * provider's own adapter sends everything there
 */
function endpointRoute({
  provider,
  apiBase,
}: {
  provider: string;
  apiBase?: string;
}): AiSdkRoute | undefined {
  switch (provider) {
    case "openai":
      // A custom endpoint (a bridge, vLLM, a gateway such as OneProvider)
      // takes the request as it is. OpenAI's own API keeps its adapter: the
      // AI SDK's Responses requests refer to earlier reasoning by stored id
      // unless store is off, where the adapter sends it whole. (Tools'
      // strict: false and the adapter's null are the same: a live check on
      // 2026-11-16 got strict false back for both; only an omitted strict
      // turns strict mode on.)
      return isOfficialOpenAI(apiBase)
        ? undefined
        : { factory: "openai-compatible" };
    case "oneprovider":
      return { factory: "openai-compatible" };
    case "deepseek":
      // DeepSeek through a gateway; DeepSeek's own API, with its FIM, stays
      return apiBase && hostOf(apiBase) !== "api.deepseek.com"
        ? { factory: "openai-compatible", emptyReasoningContent: true }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * How the AI SDK sends a model's chat requests on its endpoint, or
 * undefined when that model stays on its provider's own adapter. Each route
 * sends what the provider's own adapter sends for the same request; the
 * parity tests (test/transportParity.vitest.ts) hold them to it.
 */
export function aiSdkRoute(identity: {
  provider: string;
  model: string;
  apiBase?: string;
}): AiSdkRoute | undefined {
  // Claude keeps the Anthropic adapter (OneProvider's Messages API)
  if (identity.provider === "oneprovider" && isClaude(identity.model)) {
    return undefined;
  }
  return endpointRoute(identity);
}

/** An environment flag: set, and not empty, "0" or "false" */
function envFlag(value: string | undefined): boolean {
  return (
    value !== undefined && !["", "0", "false"].includes(value.toLowerCase())
  );
}

/**
 * The transport for a model config. An endpoint without AI-SDK routes
 * (OpenAI's own API, DeepSeek's own API, every other provider) always keeps
 * the provider's own adapter. Otherwise the model's `transport` wins, then
 * the NEXTCLI_USE_AI_SDK opt-in (CONTINUE_USE_AI_SDK is its old name, still
 * read). Without either, requests keep the provider's own adapter.
 */
export function selectTransport(
  config: { provider: string; apiBase?: string; transport?: Transport },
  env: NodeJS.ProcessEnv = process.env,
): Transport {
  if (!endpointRoute(config)) {
    return "legacy";
  }
  if (config.transport) {
    return config.transport;
  }
  return envFlag(env.NEXTCLI_USE_AI_SDK ?? env.CONTINUE_USE_AI_SDK)
    ? "ai-sdk"
    : "legacy";
}
