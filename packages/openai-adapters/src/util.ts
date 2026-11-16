import { RequestOptions } from "@nextcli/config-types";
import { fetchwithRequestOptions, patchedFetch } from "@nextcli/fetch";
import { Readable } from "node:stream";
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

/**
 * The fetch every AI-SDK provider gets. It goes through customFetch, so the
 * request options (proxy, noProxy, CA bundle, client certificate, timeout,
 * headers, extra body properties) and the proxy environment variables apply
 * whether or not the model sets request options. AI-SDK reads the response
 * body as a web stream, so node-fetch responses are converted, and the 499
 * response fetchwithRequestOptions returns for an aborted request becomes the
 * AbortError AI-SDK expects.
 */
export function aiSdkFetch(
  requestOptions: RequestOptions | undefined,
): typeof fetch {
  const inner = customFetch(requestOptions);
  return async (input, init) => {
    const response: any = await inner(input, init as any);
    if (init?.signal?.aborted) {
      throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    // A web response as it is. Decided by the body too: where the global
    // Response is node-fetch's (some test setups), instanceof alone would
    // pass a Node stream on
    if (
      response instanceof Response &&
      (response.body === null ||
        typeof (response.body as any).getReader === "function")
    ) {
      return response;
    }
    const headers = new Headers();
    response.headers?.forEach((value: string, key: string) =>
      headers.append(key, value),
    );
    const body =
      response.body && !isNullBodyStatus(response.status)
        ? (Readable.toWeb(response.body) as ReadableStream<Uint8Array>)
        : null;
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

function isNullBodyStatus(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

export function customFetch(
  requestOptions: RequestOptions | undefined,
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
    if (typeof req === "string" || req instanceof URL) {
      return fetchwithRequestOptions(req, init, requestOptions);
    } else {
      return fetchwithRequestOptions(req.url, init, requestOptions);
    }
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
