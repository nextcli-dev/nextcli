import { RequestOptions } from "@nextcli/config-types";
import { fetchwithRequestOptions, patchedFetch } from "@nextcli/fetch";
import {
  ChatCompletionChunk,
  CompletionUsage,
  CreateEmbeddingResponse,
  Model,
} from "openai/resources/index";

import { ChatCompletion } from "openai/resources/index.js";
import { CreateRerankResponse } from "./apis/base.js";

export function chatChunk(options: {
  content: string | null | undefined;
  model: string;
  finish_reason?: ChatCompletionChunk.Choice["finish_reason"];
  id?: string | null;
  usage?: CompletionUsage;
}): ChatCompletionChunk {
  return {
    choices: [
      {
        delta: {
          content: options.content,
          role: "assistant",
        },
        finish_reason:
          options.finish_reason === undefined ? "stop" : options.finish_reason,
        index: 0,
        logprobs: null,
      },
    ],
    usage: options.usage,
    created: Date.now(),
    id: options.id ?? "",
    model: options.model,
    object: "chat.completion.chunk",
  };
}

export function usageChatChunk(options: {
  model: string;
  id?: string | null;
  usage?: CompletionUsage;
}): ChatCompletionChunk {
  return {
    choices: [],
    usage: options.usage,
    created: Date.now(),
    id: options.id ?? "",
    model: options.model,
    object: "chat.completion.chunk",
  };
}

export function chatChunkFromDelta(options: {
  delta: ChatCompletionChunk.Choice["delta"];
  model: string;
  finish_reason?: ChatCompletionChunk.Choice["finish_reason"];
  id?: string | null;
  usage?: CompletionUsage;
}): ChatCompletionChunk {
  return {
    choices: [
      {
        delta: options.delta,
        finish_reason:
          options.finish_reason === undefined ? "stop" : options.finish_reason,
        index: 0,
        logprobs: null,
      },
    ],
    usage: options.usage,
    created: Date.now(),
    id: options.id ?? "",
    model: options.model,
    object: "chat.completion.chunk",
  };
}

export function chatCompletion(options: {
  content: string | null | undefined;
  model: string;
  finish_reason?: ChatCompletion.Choice["finish_reason"];
  id?: string | null;
  usage?: CompletionUsage;
  index?: number | null;
}): ChatCompletion {
  return {
    choices: [
      {
        finish_reason:
          options.finish_reason === undefined ? "stop" : options.finish_reason,
        index: options.index ?? 0,
        logprobs: null,
        message: {
          content: options.content ?? null,
          role: "assistant",
          refusal: null,
        },
      },
    ],
    usage: options.usage,
    created: Date.now(),
    id: options.id ?? "",
    model: options.model,
    object: "chat.completion",
  };
}

export function embedding(options: {
  data: number[][];
  model: string;
  usage?: CreateEmbeddingResponse.Usage;
}): CreateEmbeddingResponse {
  return {
    data: options.data.map((embedding, i) => ({
      index: i,
      embedding: embedding,
      object: "embedding" as const,
    })),
    model: options.model,
    object: "list" as const,
    usage: options.usage ?? {
      prompt_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function rerank(options: {
  model: string;
  data: number[];
  usage?: CreateRerankResponse["usage"];
}): CreateRerankResponse {
  return {
    data: options.data.map((score, index) => ({
      index,
      relevance_score: score,
    })),
    model: options.model,
    object: "list" as const,
    usage: options.usage ?? {
      total_tokens: 0,
    },
  };
}

export function model(options: { id: string; owned_by?: string }): Model {
  return {
    id: options.id,
    object: "model",
    created: Date.now(),
    owned_by: options.owned_by ?? "organization-owner",
  };
}

/** A request an adapter sends: its URL and the body as posted. */
export interface AdapterRequest {
  method: string;
  url: string;
  body: string;
}

let requestObserver: ((request: AdapterRequest) => void) | undefined;

/**
 * Sees each request with a string body that an adapter sends through
 * customFetch, after the adapter has converted it to the provider's format.
 * cn's NEXTCLI_TRACE=full sets it; undefined removes it. Not seen: token
 * exchanges, which post credentials rather than a model request, and requests
 * an SDK sends itself: Bedrock (AWS SDK) and Gemini models (@google/genai,
 * which the gemini provider and Vertex AI's Gemini streaming use).
 */
export function observeAdapterRequests(
  observer: ((request: AdapterRequest) => void) | undefined,
): void {
  requestObserver = observer;
}

/** fetchwithRequestOptions merges extraBodyProperties into a JSON body */
function bodyAsPosted(
  body: string,
  requestOptions: RequestOptions | undefined,
): string {
  if (!requestOptions?.extraBodyProperties) {
    return body;
  }
  try {
    return JSON.stringify({
      ...JSON.parse(body),
      ...requestOptions.extraBodyProperties,
    });
  } catch {
    return body;
  }
}

export function customFetch(
  requestOptions: RequestOptions | undefined,
  { tokenExchange = false }: { tokenExchange?: boolean } = {},
): typeof patchedFetch {
  if (process.env.FEATURE_FLAG_DISABLE_CUSTOM_FETCH) {
    return patchedFetch;
  }

  function letRequestOptionsOverrideAuthHeaders(init: any): any {
    if (!init || !init.headers || !requestOptions || !requestOptions.headers) {
      return init;
    }

    // Check if custom Authorization or x-api-key headers are provided
    const hasCustomAuth =
      requestOptions.headers["Authorization"] ||
      requestOptions.headers["authorization"];
    const hasCustomXApiKey =
      requestOptions.headers["x-api-key"] ||
      requestOptions.headers["X-Api-Key"];

    // Remove default auth headers if custom ones are provided
    if (hasCustomAuth || hasCustomXApiKey) {
      if (init.headers instanceof Headers) {
        if (hasCustomAuth) {
          init.headers.delete("Authorization");
        }
        if (hasCustomXApiKey) {
          init.headers.delete("x-api-key");
        }
      } else if (Array.isArray(init.headers)) {
        init.headers = init.headers.filter((header: [string, string]) => {
          const headerLower = (header[0] ?? "").toLowerCase();
          if (hasCustomAuth && headerLower === "authorization") return false;
          if (hasCustomXApiKey && headerLower === "x-api-key") return false;
          return true;
        });
      } else if (typeof init.headers === "object") {
        if (hasCustomAuth) {
          delete init.headers["Authorization"];
          delete init.headers["authorization"];
        }
        if (hasCustomXApiKey) {
          delete init.headers["x-api-key"];
          delete init.headers["X-Api-Key"];
        }
      }
    }
    return init;
  }

  return (req: URL | string | Request, init?: any) => {
    init = letRequestOptionsOverrideAuthHeaders(init);
    const url = typeof req === "string" || req instanceof URL ? req : req.url;
    if (requestObserver && !tokenExchange && typeof init?.body === "string") {
      requestObserver({
        method: init.method ?? "GET",
        url: url.toString(),
        body: bodyAsPosted(init.body, requestOptions),
      });
    }
    return fetchwithRequestOptions(url, init, requestOptions);
  };
}

/**
 * Sets an empty `reasoning_content` on assistant messages that lack it.
 * DeepSeek (and Moonshot Kimi) reject a request whose earlier assistant
 * tool-call messages have no `reasoning_content` ("Missing reasoning_content
 * field", 400). Callers that don't keep the model's reasoning, such as the
 * CLI, would otherwise fail on the second turn of every tool call (#12246).
 * Core does the same in `core/llm/openaiTypeConverters.ts`.
 */
export function addEmptyReasoningContent<
  T extends { messages: Array<{ role: string }> },
>(body: T): T {
  for (const message of body.messages) {
    if (message.role === "assistant" && !("reasoning_content" in message)) {
      (message as { reasoning_content?: string }).reasoning_content = "";
    }
  }
  return body;
}
