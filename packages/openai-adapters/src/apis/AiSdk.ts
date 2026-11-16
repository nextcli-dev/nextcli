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
import { aiSdkRoute, type AiSdkRoute } from "../transport.js";
import { AiSdkConfig, LLMConfig } from "../types.js";
import { addEmptyReasoningContent, aiSdkFetch, embedding } from "../util.js";
import { filterAnthropicSamplingParams } from "./AnthropicUtils.js";
import {
  BaseLlmApi,
  CreateRerankResponse,
  FimCreateParamsStreaming,
  RerankCreateParams,
} from "./base.js";
import { DEEPSEEK_API_BASE } from "./DeepSeek.js";
import { ONEPROVIDER_API_BASE } from "./OneProvider.js";
import { chatSamplingParams } from "./OpenAI.js";

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
 * The providers of `provider: "ai-sdk"` configs, whose model is
 * `<provider>/<model>`. Every provider gets an explicit key, base URL and
 * fetch. Left unset, the AI SDK providers would read ANTHROPIC_API_KEY,
 * ANTHROPIC_BASE_URL, OPENAI_API_KEY, OPENAI_BASE_URL and the like from the
 * environment, and so send a key the config never named, or send requests
 * to another host.
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

/** The default host of each provider with AI-SDK routes */
const DEFAULT_BASES: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  oneprovider: ONEPROVIDER_API_BASE,
  deepseek: DEEPSEEK_API_BASE,
};

/**
 * The providerOptions key of OpenAI-compatible routes. The compatible
 * provider also reads messages' and parts' fields under this key.
 */
const COMPATIBLE = "openaiCompatible";

/**
 * Chat Completions fields that become AI SDK call settings. Every other
 * field (reasoning_effort, thinking, service_tier, parallel_tool_calls, a
 * gateway's own parameters) goes into the request body as it is, as the
 * provider's own adapter sends it. nextcli_* fields are read by the request
 * code and never sent.
 */
const CALL_FIELDS = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "max_tokens",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "stop",
  "seed",
  "tools",
  "tool_choice",
]);

function bodyFields(body: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key, value]) =>
        value !== undefined &&
        !CALL_FIELDS.has(key) &&
        !key.startsWith("nextcli_"),
    ),
  );
}

/** The fields of a chat request that decide its AI SDK call */
type ChatRequest = {
  model: string;
  temperature?: number | null;
  top_p?: number | null;
};

/** The converted prompt, which a route can adjust before the call */
interface Prompt {
  instructions?: any;
  messages: any[];
  tools?: Record<string, any>;
}

/** Call settings a route decides; the body's own are used otherwise */
interface CallSettings {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  toolChoice?: any;
}

/**
 * The AI SDK sends `tool_choice: auto` whenever there are tools. The
 * providers' own adapters send none unless the caller chose one, and some
 * servers treat an explicit "auto" differently from the default (vLLM
 * needs a flag for it), so a choice the caller didn't make is left out.
 */
function withoutDefaultToolChoice(
  args: Record<string, any>,
  callerChoice: unknown,
): Record<string, any> {
  if (callerChoice === undefined) {
    delete args.tool_choice;
  }
  return args;
}

/** One chat request as an AI SDK call */
interface ChatCall {
  model: any;
  modelId: string;
  /** The provider name the tool choice rules use */
  toolChoiceProvider: string;
  settings: CallSettings;
  providerOptions?: Record<string, Record<string, unknown>>;
  /** See AiSdkProvider.reasoningDetails */
  reasoningDetails?: boolean;
  prompt?: (prompt: Prompt) => Prompt;
}

/** Retries for a failed request (429 and 5xx), as the OpenAI SDK does */
const MAX_RETRIES = 2;

/**
 * Sends chat requests through the AI SDK.
 *
 * - A `provider: "ai-sdk"` config names its provider in the model,
 *   `<provider>/<model>`.
 * - Any other config is a provider's normal config (transport.ts chose the
 *   AI SDK for it), together with that provider's own adapter. Each request
 *   takes its model's route (transport.ts aiSdkRoute); a model without one,
 *   and every request that isn't chat (completions, FIM, embeddings, rerank,
 *   listing models), goes to the provider's own adapter.
 */
export class AiSdkApi implements BaseLlmApi {
  private config: AiSdkConfig | LLMConfig;
  private legacy?: BaseLlmApi;
  /** For `provider: "ai-sdk"` configs */
  private fixed?: {
    providerId: string;
    modelId: string;
    provider: AiSdkProvider;
  };

  constructor(config: AiSdkConfig | LLMConfig, legacy?: BaseLlmApi) {
    this.config = config;
    this.legacy = legacy;
    if (config.provider !== "ai-sdk") {
      if (!legacy) {
        throw new Error(
          `The AI SDK transport for "${config.provider}" needs that provider's own adapter.`,
        );
      }
      return;
    }
    if (!config.model) {
      throw new Error(
        "AI SDK provider requires a model in the format '<provider>/<model>' (e.g., 'openai/gpt-4o')",
      );
    }
    const [providerId, ...modelParts] = config.model.split("/");
    const provider = PROVIDERS[providerId];
    if (!provider) {
      throw new Error(
        `Unknown AI SDK provider: "${providerId}". ` +
          `Supported providers: ${Object.keys(PROVIDERS).join(", ")}.`,
      );
    }
    this.fixed = { providerId, modelId: modelParts.join("/"), provider };
  }

  private settings(defaultBaseURL: string): ProviderSettings {
    return {
      apiKey: this.config.apiKey ?? "",
      baseURL: this.config.apiBase || defaultBaseURL,
      fetch: aiSdkFetch(this.config.requestOptions),
    };
  }

  /** The AI SDK call for a request, or undefined for the own adapter */
  private chatCall(body: ChatRequest): ChatCall | undefined {
    if (this.fixed) {
      return this.fixedCall(body);
    }
    const route = aiSdkRoute({
      provider: this.config.provider,
      model: body.model,
      apiBase: this.config.apiBase,
    });
    if (!route) {
      return undefined;
    }
    switch (route.factory) {
      case "openai-compatible":
        return this.compatibleCall(body, route);
      default:
        return undefined;
    }
  }

  private fixedCall(body: ChatRequest): ChatCall {
    const { providerId, modelId: fixedModel, provider } = this.fixed!;
    const modelId = fixedModel || body.model;
    let temperature = body.temperature ?? undefined;
    let topP = body.top_p ?? undefined;
    if (providerId === "anthropic") {
      ({ temperature, topP } = filterAnthropicSamplingParams(modelId, {
        temperature,
        topP,
      }));
    }
    return {
      model: provider.create(this.settings(provider.defaultBaseURL))(modelId),
      modelId,
      toolChoiceProvider: providerId,
      settings: { temperature, topP },
      reasoningDetails: provider.reasoningDetails,
    };
  }

  /**
   * A Chat Completions endpoint that isn't OpenAI's own: a bridge, a local
   * server, a gateway. The request is what OpenAIApi sends: the body's own
   * fields pass through, and only the sampling rules apply.
   */
  private compatibleCall(body: ChatRequest, route: AiSdkRoute): ChatCall {
    const toolChoiceSet = (body as { tool_choice?: unknown }).tool_choice;
    const provider = createOpenAICompatible({
      name: COMPATIBLE,
      includeUsage: true,
      ...this.settings(DEFAULT_BASES[this.config.provider]),
      transformRequestBody: (args: Record<string, any>) => {
        withoutDefaultToolChoice(args, toolChoiceSet);
        return route.emptyReasoningContent
          ? addEmptyReasoningContent(args as { messages: { role: string }[] })
          : args;
      },
    });
    const sampling = chatSamplingParams(body.model, body);
    return {
      model: provider.chatModel(body.model),
      modelId: body.model,
      toolChoiceProvider: this.config.provider,
      settings: { temperature: sampling.temperature, topP: sampling.top_p },
      providerOptions: { [COMPATIBLE]: bodyFields(body) },
      // A gateway's reasoning_details pass through as they came
      reasoningDetails: true,
    };
  }

  async chatCompletionNonStream(
    body: ChatCompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<ChatCompletion> {
    if (this.legacy && !this.chatCall(body)) {
      return this.legacy.chatCompletionNonStream(body, signal);
    }
    const { collectChatCompletion } = await import("../aiSdkCompletion.js");
    return collectChatCompletion(
      this.chatCompletionStream({ ...body, stream: true }, signal),
      this.fixed?.modelId || body.model,
    );
  }

  async *chatCompletionStream(
    body: ChatCompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    const call = this.chatCall(body);
    if (!call) {
      yield* this.legacy!.chatCompletionStream(body, signal);
      return;
    }

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

    const converted = convertOpenAIMessagesToVercel(body.messages);
    let prompt: Prompt = {
      instructions: converted.instructions,
      messages: converted.messages,
      tools: await convertToolsToVercelFormat(body.tools),
    };
    if (call.prompt) {
      prompt = call.prompt(prompt);
    }

    const result = streamText({
      model: call.model,
      instructions: prompt.instructions,
      messages: prompt.messages,
      frequencyPenalty: body.frequency_penalty ?? undefined,
      presencePenalty: body.presence_penalty ?? undefined,
      seed: body.seed ?? undefined,
      maxOutputTokens: body.max_tokens ?? undefined,
      stopSequences: body.stop
        ? Array.isArray(body.stop)
          ? body.stop
          : [body.stop]
        : undefined,
      tools: prompt.tools,
      toolChoice: convertToolChoiceToVercel(body.tool_choice, {
        provider: call.toolChoiceProvider,
        model: call.modelId,
      }),
      ...call.settings,
      providerOptions: call.providerOptions as any,
      maxRetries: MAX_RETRIES,
      abortSignal: signal,
      includeRawChunks: call.reasoningDetails,
      // Errors come through the stream as error parts, which the converter
      // throws; don't also print them
      onError: () => {},
    });

    yield* convertVercelStream(result.stream as any, {
      model: call.modelId,
      reasoningDetailsFromRaw: call.reasoningDetails,
    });
  }

  async completionNonStream(
    body: CompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<Completion> {
    if (this.legacy) {
      return this.legacy.completionNonStream(body, signal);
    }
    throw new Error(
      "AI SDK provider does not support legacy completions API. Use chat completions instead.",
    );
  }

  async *completionStream(
    body: CompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<Completion> {
    if (this.legacy) {
      yield* this.legacy.completionStream(body, signal);
      return;
    }
    throw new Error(
      "AI SDK provider does not support legacy completions API. Use chat completions instead.",
    );
  }

  async *fimStream(
    body: FimCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    if (this.legacy) {
      yield* this.legacy.fimStream(body, signal);
      return;
    }
    throw new Error(
      "AI SDK provider does not support fill-in-the-middle (FIM) completions.",
    );
  }

  async embed(body: EmbeddingCreateParams): Promise<CreateEmbeddingResponse> {
    if (this.legacy) {
      return this.legacy.embed(body);
    }
    const { providerId, provider } = this.fixed!;
    if (!provider.embedding) {
      throw new Error(
        `AI SDK provider "${providerId}" does not support embeddings.`,
      );
    }
    const { embedMany } = await import("ai");

    const modelId = String(body.model);
    const model = provider.embedding(this.settings(provider.defaultBaseURL))(
      modelId,
    );
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

  async rerank(body: RerankCreateParams): Promise<CreateRerankResponse> {
    if (this.legacy) {
      return this.legacy.rerank(body);
    }
    throw new Error("AI SDK provider does not support reranking.");
  }

  async list(): Promise<Model[]> {
    return this.legacy ? this.legacy.list() : [];
  }
}
