import { ChatCompletionCreateParams } from "openai/resources/index";

import { OpenRouterConfig } from "../types.js";
import {
  CachingStrategyName,
  DEFAULT_CACHING_STRATEGY,
} from "./AnthropicCachingStrategies.js";
import { OpenAIApi } from "./OpenAI.js";
import { applyAnthropicCachingToOpenRouterBody } from "./OpenRouterCaching.js";

// TODO: Extract detailed error info from OpenRouter's error.metadata.raw to surface better messages

// OpenRouter app attribution: the referer identifies the app, the title is
// its display name (X-Title is the older name of the same header)
export const OPENROUTER_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://nextcli.dev/",
  "X-OpenRouter-Title": "NextCLI",
  "X-Title": "NextCLI",
  "X-OpenRouter-Categories": "ide-extension",
};

/**
 * OpenRouter's unified reasoning settings: effort goes in `reasoning.effort`,
 * `reasoning.exclude` keeps the reasoning out of the response, and
 * `reasoning.enabled: false` turns thinking off.
 */
function applyOpenRouterControls(
  body: ChatCompletionCreateParams,
  controls: { showThinking?: boolean; thinking?: string },
): void {
  const target = body as ChatCompletionCreateParams & {
    reasoning?: Record<string, unknown>;
  };
  if (controls.thinking === "off") {
    // An effort would turn thinking back on
    delete target.reasoning_effort;
    target.reasoning = { enabled: false };
    return;
  }
  if (body.reasoning_effort) {
    target.reasoning = { ...target.reasoning, effort: body.reasoning_effort };
    delete target.reasoning_effort;
  } else if (controls.thinking === "shown") {
    // Claude 5 returns its reasoning text only when `reasoning` is set
    // (checked 2026-11-04)
    target.reasoning = { ...target.reasoning, enabled: true };
  }
  if (controls.showThinking === false) {
    target.reasoning = { ...target.reasoning, exclude: true };
  }
}

export class OpenRouterApi extends OpenAIApi {
  /**
   * Prompt caching for Claude models. `none` adds no cache_control at all,
   * as in AnthropicApi: core passes it and marks the body itself.
   */
  private readonly cachingStrategy: CachingStrategyName;

  constructor(config: OpenRouterConfig) {
    super({
      ...config,
      provider: "openai",
      apiBase: config.apiBase ?? "https://openrouter.ai/api/v1/",
      requestOptions: {
        ...config.requestOptions,
        headers: {
          ...OPENROUTER_HEADERS,
          ...config.requestOptions?.headers,
        },
      },
    });
    this.cachingStrategy = config.cachingStrategy ?? DEFAULT_CACHING_STRATEGY;
  }

  private isAnthropicModel(model?: string): boolean {
    if (!model) {
      return false;
    }
    const modelLower = model.toLowerCase();
    return modelLower.includes("claude");
  }

  override modifyChatBody<T extends ChatCompletionCreateParams>(body: T): T {
    // Read the model menu controls before the base class drops nextcli_* fields
    const { nextcli_show_thinking: showThinking, nextcli_thinking: thinking } =
      body as T & {
        nextcli_show_thinking?: boolean;
        nextcli_thinking?: string;
      };
    const modifiedBody = super.modifyChatBody(body);
    applyOpenRouterControls(modifiedBody, { showThinking, thinking });

    if (
      !this.isAnthropicModel(modifiedBody.model) ||
      this.cachingStrategy === "none"
    ) {
      return modifiedBody;
    }

    applyAnthropicCachingToOpenRouterBody(
      modifiedBody as unknown as ChatCompletionCreateParams,
      this.cachingStrategy,
    );

    return modifiedBody;
  }
}

export default OpenRouterApi;
