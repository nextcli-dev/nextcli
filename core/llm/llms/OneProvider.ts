import { isClaude } from "@nextcli/llm-info";
import {
  ONEPROVIDER_API_BASE,
  type OneProviderConfig,
} from "@nextcli/openai-adapters";

import { LLMOptions } from "../../index.js";

import OpenAI from "./OpenAI.js";

/**
 * OneProvider (https://oneprovider.dev): one key for many vendors' models.
 * Requests go through the OneProvider adapter in @nextcli/openai-adapters,
 * which sends Claude to OneProvider's Anthropic Messages API (thinking,
 * effort and fast mode as with Anthropic) and every other model to its
 * OpenAI-compatible API. OneProvider has no FIM or raw completions route, so
 * autocomplete uses chat.
 */
class OneProvider extends OpenAI {
  static providerName = "oneprovider";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: ONEPROVIDER_API_BASE,
    useLegacyCompletionsEndpoint: false,
  };

  constructor(options: LLMOptions) {
    super(options);
    // Claude needs its signed thinking back; DeepSeek and Kimi need
    // reasoning_content on earlier assistant messages
    const claude = isClaude(this.model ?? "");
    this.supportsReasoningDetailsField = claude;
    this.supportsReasoningContentField = !claude;
  }

  supportsFim(): boolean {
    return false;
  }

  /**
   * Claude prompt caching only when the model config asks for it, as core's
   * Anthropic class does; the adapter would otherwise always cache
   */
  protected adapterConfig(): OneProviderConfig {
    const caching =
      this.cacheBehavior?.cacheSystemMessage ||
      this.cacheBehavior?.cacheConversation ||
      this.completionOptions.promptCaching;
    return {
      ...(super.adapterConfig() as OneProviderConfig),
      cachingStrategy: caching ? "systemAndTools" : "none",
    };
  }
}

export default OneProvider;
