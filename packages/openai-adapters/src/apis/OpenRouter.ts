import { ChatCompletionCreateParams } from "openai/resources/index";

import { OpenAIConfig } from "../types.js";
import { OpenAIApi } from "./OpenAI.js";
import { applyAnthropicCachingToOpenRouterBody } from "./OpenRouterCaching.js";

export interface OpenRouterConfig extends OpenAIConfig {
  cachingStrategy?: import("./AnthropicCachingStrategies.js").CachingStrategyName;
}

// TODO: Extract detailed error info from OpenRouter's error.metadata.raw to surface better messages

export const OPENROUTER_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://nextcli.dev/",
  "X-OpenRouter-Title": "Continue",
  "X-OpenRouter-Categories": "ide-extension",
};

/**
 * OpenRouter's unified reasoning settings: effort goes in `reasoning.effort`,
 * and `reasoning.exclude` keeps the reasoning out of the response.
 */
function applyOpenRouterControls(
  body: ChatCompletionCreateParams,
  controls: { showThinking?: boolean },
): void {
  const target = body as ChatCompletionCreateParams & {
    reasoning?: Record<string, unknown>;
  };
  if (body.reasoning_effort) {
    target.reasoning = { ...target.reasoning, effort: body.reasoning_effort };
    delete target.reasoning_effort;
  }
  if (controls.showThinking === false) {
    target.reasoning = { ...target.reasoning, exclude: true };
  }
}

export class OpenRouterApi extends OpenAIApi {
  constructor(config: OpenRouterConfig) {
    super({
      ...config,
      apiBase: config.apiBase ?? "https://openrouter.ai/api/v1/",
      requestOptions: {
        ...config.requestOptions,
        headers: {
          ...OPENROUTER_HEADERS,
          ...config.requestOptions?.headers,
        },
      },
    });
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
    const showThinking = (body as T & { nextcli_show_thinking?: boolean })
      .nextcli_show_thinking;
    const modifiedBody = super.modifyChatBody(body);
    applyOpenRouterControls(modifiedBody, { showThinking });

    if (!this.isAnthropicModel(modifiedBody.model)) {
      return modifiedBody;
    }

    applyAnthropicCachingToOpenRouterBody(
      modifiedBody as unknown as ChatCompletionCreateParams,
      (this.config as OpenRouterConfig).cachingStrategy ?? "systemAndTools",
    );

    return modifiedBody;
  }
}

export default OpenRouterApi;
