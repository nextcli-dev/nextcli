import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
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
import { aiSdkRoute, type AiSdkRoute } from "../transport.js";
import { LLMConfig } from "../types.js";
import { addEmptyReasoningContent, aiSdkFetch } from "../util.js";
import {
  BaseLlmApi,
  CreateRerankResponse,
  FimCreateParamsStreaming,
  RerankCreateParams,
} from "./base.js";
import { DEEPSEEK_API_BASE } from "./DeepSeek.js";
import { ONEPROVIDER_API_BASE } from "./OneProvider.js";
import { chatSamplingParams } from "./OpenAI.js";

/** The default host of each provider with AI-SDK routes */
const DEFAULT_BASES: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  oneprovider: ONEPROVIDER_API_BASE,
  deepseek: DEEPSEEK_API_BASE,
};

/**
 * The providerOptions key of the OpenAI-compatible route. The compatible
 * provider puts its fields into the body as they are, and reads messages'
 * and parts' fields under the same key.
 */
const COMPATIBLE = "openaiCompatible";

/**
 * The request fields the AI SDK writes itself, from the converted messages
 * and tools. Every other field (max_tokens, temperature, stop,
 * reasoning_effort, thinking, a gateway's own parameters) goes into the body
 * as the caller sent it, as OpenAIApi sends it. nextcli_* fields are read by
 * the request code and never sent.
 */
const SDK_FIELDS = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "stream",
  "stream_options",
]);

/** The caller's own fields, with the sampling rules OpenAIApi applies */
function bodyFields(body: {
  model: string;
  temperature?: number | null;
  top_p?: number | null;
}): Record<string, unknown> {
  const fields: Record<string, unknown> = Object.fromEntries(
    Object.entries(body).filter(
      ([key, value]) =>
        value !== undefined &&
        !SDK_FIELDS.has(key) &&
        !key.startsWith("nextcli_"),
    ),
  );
  delete fields.temperature;
  delete fields.top_p;
  const sampling = chatSamplingParams(body.model, body);
  for (const [key, value] of Object.entries(sampling)) {
    if (value !== undefined) fields[key] = value;
  }
  return fields;
}

/**
 * The AI SDK writes `tool_choice: auto` whenever there are tools. The
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

/** Retries for a failed request (429 and 5xx), as the OpenAI SDK does */
const MAX_RETRIES = 2;

/**
 * Sends a provider's chat requests through the AI SDK, together with that
 * provider's own adapter (transport.ts chose the AI SDK for the config).
 * Each request takes its model's route (transport.ts aiSdkRoute). A model
 * without one, and every request that isn't chat (completions, FIM,
 * embeddings, rerank, listing models), goes to the provider's own adapter.
 */
export class AiSdkApi implements BaseLlmApi {
  /**
   * @param modelPrefix A `provider: "ai-sdk"` config names its vendor in the
   *   model (`openai/gpt-x`). Requests carry that name; both transports get
   *   it without the prefix.
   */
  constructor(
    private readonly config: LLMConfig,
    private readonly own: BaseLlmApi,
    private readonly modelPrefix = "",
  ) {}

  /** The route a model's chat requests take; undefined: the own adapter */
  routeFor(model: string): AiSdkRoute | undefined {
    return aiSdkRoute({
      provider: this.config.provider,
      model: this.modelName(model),
      apiBase: this.config.apiBase,
    });
  }

  private modelName(model: string): string {
    return this.modelPrefix && model.startsWith(this.modelPrefix)
      ? model.slice(this.modelPrefix.length)
      : model;
  }

  private named<T extends { model: string }>(body: T): T {
    return { ...body, model: this.modelName(body.model) };
  }

  /**
   * A Chat Completions endpoint that isn't OpenAI's own: a bridge, a local
   * server, a gateway. The request is what OpenAIApi sends.
   */
  private compatibleModel(
    body: ChatCompletionCreateParamsStreaming,
    route: AiSdkRoute,
  ) {
    return createOpenAICompatible({
      name: COMPATIBLE,
      includeUsage: true,
      // Explicit, so no AI SDK provider reads a key or host from the
      // environment
      apiKey: this.config.apiKey ?? "",
      baseURL: this.config.apiBase || DEFAULT_BASES[this.config.provider],
      fetch: aiSdkFetch(this.config.requestOptions),
      transformRequestBody: (args: Record<string, any>) => {
        withoutDefaultToolChoice(args, body.tool_choice);
        return route.emptyReasoningContent
          ? addEmptyReasoningContent(args as { messages: { role: string }[] })
          : args;
      },
    }).chatModel(body.model);
  }

  async chatCompletionNonStream(
    body: ChatCompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<ChatCompletion> {
    const named = this.named(body);
    if (!this.routeFor(named.model)) {
      return this.own.chatCompletionNonStream(named, signal);
    }
    const { collectChatCompletion } = await import("../aiSdkCompletion.js");
    return collectChatCompletion(
      this.chatCompletionStream({ ...named, stream: true }, signal),
      named.model,
    );
  }

  async *chatCompletionStream(
    body: ChatCompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    const named = this.named(body);
    const route = this.routeFor(named.model);
    if (!route) {
      yield* this.own.chatCompletionStream(named, signal);
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

    const { instructions, messages } = convertOpenAIMessagesToVercel(
      named.messages,
    );
    const result = streamText({
      model: this.compatibleModel(named, route),
      instructions,
      messages: messages as any,
      tools: await convertToolsToVercelFormat(named.tools),
      toolChoice: convertToolChoiceToVercel(named.tool_choice),
      providerOptions: { [COMPATIBLE]: bodyFields(named) } as any,
      maxRetries: MAX_RETRIES,
      abortSignal: signal,
      // A gateway's reasoning_details pass through as they came
      includeRawChunks: true,
      // Errors come through the stream as error parts, which the converter
      // throws; don't also print them
      onError: () => {},
    });

    yield* convertVercelStream(result.stream as any, {
      model: named.model,
      reasoningDetailsFromRaw: true,
    });
  }

  completionNonStream(
    body: CompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<Completion> {
    return this.own.completionNonStream(this.named(body), signal);
  }

  completionStream(
    body: CompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<Completion> {
    return this.own.completionStream(this.named(body), signal);
  }

  fimStream(
    body: FimCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    return this.own.fimStream(this.named(body), signal);
  }

  embed(body: EmbeddingCreateParams): Promise<CreateEmbeddingResponse> {
    return this.own.embed({
      ...body,
      model: this.modelName(String(body.model)),
    });
  }

  rerank(body: RerankCreateParams): Promise<CreateRerankResponse> {
    return this.own.rerank(this.named(body));
  }

  list(): Promise<Model[]> {
    return this.own.list();
  }
}
