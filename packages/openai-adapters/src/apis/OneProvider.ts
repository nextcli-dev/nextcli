import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  Completion,
  CompletionCreateParamsNonStreaming,
  CompletionCreateParamsStreaming,
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
  Model,
} from "openai/resources/index";

import { getControlsFormat } from "../modelControls.js";
import { OneProviderConfig } from "../types.js";

import { AnthropicApi } from "./Anthropic.js";
import {
  BaseLlmApi,
  CreateRerankResponse,
  FimCreateParamsStreaming,
  RerankCreateParams,
} from "./base.js";
import { OpenAIApi } from "./OpenAI.js";

export const ONEPROVIDER_API_BASE = "https://api.oneprovider.dev/v1/";

/**
 * OneProvider (https://oneprovider.dev): one key for many vendors' models.
 * Claude models go through its Anthropic Messages API (`/v1/messages`, the
 * same request and response shape as Anthropic's), so thinking, effort, fast
 * mode and sampling parameters work as they do with Anthropic. Every other
 * model goes through its OpenAI-compatible API (`/v1/chat/completions`).
 * Requests are routed by model, so one configured provider covers both.
 */
export class OneProviderApi implements BaseLlmApi {
  private anthropic: AnthropicApi;
  private openai: OpenAIApi;

  constructor(config: OneProviderConfig) {
    const apiBase = config.apiBase ?? ONEPROVIDER_API_BASE;
    // Anthropic requests send the key as x-api-key, OpenAI requests as a
    // Bearer token. OneProvider accepts either, but not both at once.
    this.anthropic = new AnthropicApi({
      ...config,
      provider: "anthropic",
      apiBase,
    });
    this.openai = new OpenAIApi({ ...config, provider: "openai", apiBase });
  }

  private apiFor(model: string): BaseLlmApi {
    return getControlsFormat({ provider: "oneprovider", model }) === "anthropic"
      ? this.anthropic
      : this.openai;
  }

  chatCompletionNonStream(
    body: ChatCompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<ChatCompletion> {
    return this.apiFor(body.model).chatCompletionNonStream(body, signal);
  }

  chatCompletionStream(
    body: ChatCompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    return this.apiFor(body.model).chatCompletionStream(body, signal);
  }

  completionNonStream(
    body: CompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<Completion> {
    return this.openai.completionNonStream(body, signal);
  }

  completionStream(
    body: CompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<Completion> {
    return this.openai.completionStream(body, signal);
  }

  fimStream(
    body: FimCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    return this.openai.fimStream(body, signal);
  }

  embed(body: EmbeddingCreateParams): Promise<CreateEmbeddingResponse> {
    return this.openai.embed(body);
  }

  rerank(body: RerankCreateParams): Promise<CreateRerankResponse> {
    return this.openai.rerank(body);
  }

  /** Every model, Claude included, from `GET /v1/models` */
  list(): Promise<Model[]> {
    return this.openai.list();
  }
}
