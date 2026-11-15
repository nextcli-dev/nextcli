import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
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
import { formatAiSdkError } from "../aiSdkErrors.js";
import { AiSdkConfig } from "../types.js";
import { aiSdkFetch, embedding } from "../util.js";
import { filterAnthropicSamplingParams } from "./AnthropicUtils.js";
import {
  BaseLlmApi,
  CreateRerankResponse,
  FimCreateParamsStreaming,
  RerankCreateParams,
} from "./base.js";

interface ProviderSettings {
  apiKey: string;
  baseURL: string;
  fetch: typeof fetch;
}

interface AiSdkProvider {
  /** Each provider's own default host, used when the config sets none */
  defaultBaseURL: string;
  create(settings: ProviderSettings): (modelId: string) => any;
  /** Embedding models, for providers that have them */
  embedding?(settings: ProviderSettings): (modelId: string) => any;
  /**
   * The provider streams and accepts OpenRouter-style `reasoning_details`,
   * which the AI SDK model doesn't parse: read them from the raw chunks and
   * send them back as they came (see openaiToVercelMessages.ts)
   */
  reasoningDetails?: boolean;
}

/**
 * A gateway that speaks OpenAI Chat Completions. The compatible provider,
 * unlike createOpenAI().chat, sends reasoning back as `reasoning_content`
 * and passes `reasoning_details` through.
 */
function openAICompatible(name: string) {
  return (settings: ProviderSettings) =>
    createOpenAICompatible({ name, includeUsage: true, ...settings });
}

/**
 * Every provider gets an explicit key, base URL and fetch. Left unset, the
 * AI SDK providers would read ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL,
 * OPENAI_API_KEY, OPENAI_BASE_URL and the like from the environment, and so
 * send a key the config never named, or send requests to another host.
 */
const PROVIDERS: Record<string, AiSdkProvider> = {
  openai: {
    defaultBaseURL: "https://api.openai.com/v1",
    create: (settings) => createOpenAI(settings),
    embedding: (settings) => createOpenAI(settings).embedding,
  },
  anthropic: {
    defaultBaseURL: "https://api.anthropic.com/v1",
    create: (settings) => createAnthropic(settings),
  },
  google: {
    defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
    create: (settings) => createGoogle(settings),
    embedding: (settings) => createGoogle(settings).embedding,
  },
  xai: {
    defaultBaseURL: "https://api.x.ai/v1",
    create: (settings) => createXai(settings),
  },
  deepseek: {
    defaultBaseURL: "https://api.deepseek.com",
    create: (settings) => createDeepSeek(settings),
  },
  openrouter: {
    defaultBaseURL: "https://openrouter.ai/api/v1",
    create: openAICompatible("openrouter"),
    reasoningDetails: true,
  },
  clawrouter: {
    defaultBaseURL: "http://localhost:1337/v1",
    create: openAICompatible("clawrouter"),
    reasoningDetails: true,
  },
};

/** Retries for a failed request (429 and 5xx), as the OpenAI SDK does */
const MAX_RETRIES = 2;

export class AiSdkApi implements BaseLlmApi {
  private config: AiSdkConfig;
  private providerId: string;
  private modelId: string;
  private provider: AiSdkProvider;

  constructor(config: AiSdkConfig) {
    this.config = config;
    if (!config.model) {
      throw new Error(
        "AI SDK provider requires a model in the format '<provider>/<model>' (e.g., 'openai/gpt-4o')",
      );
    }
    const [providerId, ...modelParts] = config.model.split("/");
    this.providerId = providerId;
    this.modelId = modelParts.join("/");
    const provider = PROVIDERS[providerId];
    if (!provider) {
      throw new Error(
        `Unknown AI SDK provider: "${providerId}". ` +
          `Supported providers: ${Object.keys(PROVIDERS).join(", ")}.`,
      );
    }
    this.provider = provider;
  }

  private settings(): ProviderSettings {
    return {
      apiKey: this.config.apiKey ?? "",
      baseURL: this.config.apiBase || this.provider.defaultBaseURL,
      fetch: aiSdkFetch(this.config.requestOptions),
    };
  }

  private samplingParams(body: {
    temperature?: number | null;
    top_p?: number | null;
  }): { temperature?: number; topP?: number } {
    const params = {
      temperature: body.temperature ?? undefined,
      topP: body.top_p ?? undefined,
    };
    if (this.providerId !== "anthropic") {
      return params;
    }
    const { temperature, topP } = filterAnthropicSamplingParams(
      this.modelId,
      params,
    );
    return { temperature, topP };
  }

  async chatCompletionNonStream(
    body: ChatCompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<ChatCompletion> {
    const { collectChatCompletion } = await import("../aiSdkCompletion.js");
    return collectChatCompletion(
      this.chatCompletionStream({ ...body, stream: true }, signal),
      this.modelId || body.model,
    );
  }

  async *chatCompletionStream(
    body: ChatCompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    const { streamText } = await import("ai");
    const { convertOpenAIMessagesToVercel } = await import(
      "../openaiToVercelMessages.js"
    );
    const { convertToolsToVercelFormat } = await import(
      "../convertToolsToVercel.js"
    );
    const { convertVercelStream } = await import("../vercelStreamConverter.js");
    const { convertToolChoiceToVercel } = await import(
      "../convertToolChoiceToVercel.js"
    );

    const { instructions, messages } = convertOpenAIMessagesToVercel(
      body.messages,
    );
    const modelId = this.modelId || body.model;
    const model = this.provider.create(this.settings())(modelId);
    const tools = await convertToolsToVercelFormat(body.tools);

    const result = streamText({
      model,
      instructions,
      messages: messages as any,
      ...this.samplingParams(body),
      maxOutputTokens: body.max_tokens ?? undefined,
      stopSequences: body.stop
        ? Array.isArray(body.stop)
          ? body.stop
          : [body.stop]
        : undefined,
      tools,
      toolChoice: convertToolChoiceToVercel(body.tool_choice, {
        provider: this.providerId,
        model: modelId,
      }),
      maxRetries: MAX_RETRIES,
      abortSignal: signal,
      includeRawChunks: this.provider.reasoningDetails,
      // Errors come through the stream as error parts, which the converter
      // throws; don't also print them
      onError: () => {},
    });

    yield* convertVercelStream(result.stream as any, {
      model: modelId,
      reasoningDetailsFromRaw: this.provider.reasoningDetails,
    });
  }

  async completionNonStream(
    _body: CompletionCreateParamsNonStreaming,
    _signal: AbortSignal,
  ): Promise<Completion> {
    throw new Error(
      "AI SDK provider does not support legacy completions API. Use chat completions instead.",
    );
  }

  async *completionStream(
    _body: CompletionCreateParamsStreaming,
    _signal: AbortSignal,
  ): AsyncGenerator<Completion> {
    throw new Error(
      "AI SDK provider does not support legacy completions API. Use chat completions instead.",
    );
  }

  async *fimStream(
    _body: FimCreateParamsStreaming,
    _signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    throw new Error(
      "AI SDK provider does not support fill-in-the-middle (FIM) completions.",
    );
  }

  async embed(body: EmbeddingCreateParams): Promise<CreateEmbeddingResponse> {
    if (!this.provider.embedding) {
      throw new Error(
        `AI SDK provider "${this.providerId}" does not support embeddings.`,
      );
    }
    const { embedMany } = await import("ai");

    const modelId = String(body.model);
    const model = this.provider.embedding(this.settings())(modelId);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const values = inputs.map((input) =>
      typeof input === "string" ? input : String(input),
    );

    try {
      const result = await embedMany({
        model,
        values,
        maxRetries: MAX_RETRIES,
      });
      return embedding({
        data: result.embeddings,
        model: modelId,
        usage: {
          prompt_tokens: result.usage?.tokens ?? 0,
          total_tokens: result.usage?.tokens ?? 0,
        },
      });
    } catch (error) {
      throw formatAiSdkError(error);
    }
  }

  async rerank(_body: RerankCreateParams): Promise<CreateRerankResponse> {
    throw new Error("AI SDK provider does not support reranking.");
  }

  async list(): Promise<Model[]> {
    return [];
  }
}
