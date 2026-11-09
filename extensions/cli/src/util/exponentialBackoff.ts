import { BaseLlmApi } from "@nextcli/openai-adapters";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources.mjs";

import { error, warn } from "../logging.js";

import { formatError } from "./formatError.js";
import { logger } from "./logger.js";

export interface ExponentialBackoffOptions {
  /** Maximum number of retry attempts */
  maxRetries?: number;
  /** Initial delay in milliseconds */
  initialDelay?: number;
  /** Maximum delay in milliseconds */
  maxDelay?: number;
  /** Multiplier for exponential backoff */
  backoffMultiplier?: number;
  /** Jitter factor to add randomness */
  jitter?: boolean;
  /** Number of retries to hide from logging */
  hiddenRetries?: number;
}

const DEFAULT_OPTIONS: Required<ExponentialBackoffOptions> = {
  maxRetries: 10,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 1.6,
  jitter: true,
  hiddenRetries: 2,
};

/** A stream that already produced a token is not repeated ten times. */
const MAX_UNFINISHED_STREAM_RETRIES = 2;

const LOCAL_EXCEPTION_NAMES = new Set([
  "TypeError",
  "ReferenceError",
  "SyntaxError",
]);

/**
 * Checks if the error is a network-related error
 */
function isNetworkError(error: any): boolean {
  const networkCodes = [
    "ECONNRESET",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EPIPE",
    "ECONNREFUSED",
  ];
  return networkCodes.includes(error.code);
}

/**
 * Checks if the HTTP status code is retryable
 */
function isRetryableHttpStatus(status: number): boolean {
  // 429 (Too Many Requests), 502 (Bad Gateway), 503 (Service Unavailable), 504 (Gateway Timeout)
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Checks if the error type indicates a server issue
 */
function isServerError(error: any): boolean {
  return error.type === "server_error" || error.type === "rate_limit_exceeded";
}

/**
 * Checks if the error message indicates a connection issue
 */
function isConnectionError(errorMessage: string): boolean {
  const connectionErrorPatterns = [
    "premature close",
    "premature end",
    "connection reset",
    "socket hang up",
    "aborted",
    "overloaded",
  ];

  return connectionErrorPatterns.some((pattern) =>
    errorMessage.includes(pattern),
  );
}

/**
 * Checks if the error indicates a context length issue (non-retryable)
 */
export function isContextLengthError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const errorMessage = error.message?.toLowerCase() || "";

  if (errorMessage.includes("invalid_request_error")) {
    if (errorMessage.includes("context")) {
      return true;
    }
  }

  const contextLengthPatterns = [
    // Anthropic Claude
    "input length and max_tokens exceed context limit",
    "decrease input length or max_tokens",
    // OpenAI
    "maximum context length",
    "reduce the length of the messages",
    // Mistral
    "tokens in the prompt exceeds",
    "use a shorter prompt",
    // Generic patterns
    "context_length_exceeded",
  ];

  return contextLengthPatterns.some((pattern) =>
    errorMessage.includes(pattern),
  );
}

/** A 4xx other than 408 and 429 is the caller's mistake, not a dead stream. */
function isClientErrorStatus(status: unknown): boolean {
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

/** The HTTP status: `status` on OpenAI errors, `statusCode` on AI SDK ones. */
function httpStatus(error: any): unknown {
  return error?.status ?? error?.statusCode;
}

function isLocalException(error: any): boolean {
  return LOCAL_EXCEPTION_NAMES.has(error?.name);
}

/**
 * An error while opening the request. An unrecognized failure, such as a bad
 * API key with no status, is not retried.
 */
export function isRetryableError(error: any): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }

  // Context length errors are never retryable - they need user intervention
  if (isContextLengthError(error)) {
    return false;
  }

  // Network errors are retryable
  if (isNetworkError(error)) {
    return true;
  }

  // HTTP status codes that are retryable
  const status = httpStatus(error);
  if (typeof status === "number" && isRetryableHttpStatus(status)) {
    return true;
  }

  // OpenAI/API specific errors
  if (isServerError(error)) {
    return true;
  }

  // Check for connection issues by message content
  const errorMessage = error.message?.toLowerCase();
  if (errorMessage && isConnectionError(errorMessage)) {
    return true;
  }

  return false;
}

/**
 * The generator already started and then threw, so the stream did not finish.
 * Retry whatever the gateway wrote, unless the error cannot succeed on another
 * try: the prompt is over the context limit, the status is a 4xx other than
 * 408 or 429, or the throw is a bug in this process.
 */
export function isUnfinishedStreamError(error: any): boolean {
  if (isContextLengthError(error)) {
    return false;
  }
  if (isClientErrorStatus(httpStatus(error))) {
    return false;
  }
  if (isLocalException(error)) {
    return false;
  }
  return true;
}

/**
 * Calculates the delay for the next retry attempt
 */
function calculateDelay(
  attempt: number,
  options: Required<ExponentialBackoffOptions>,
): number {
  const baseDelay =
    options.initialDelay * Math.pow(options.backoffMultiplier, attempt);
  const cappedDelay = Math.min(baseDelay, options.maxDelay);

  if (options.jitter) {
    // Add jitter: randomize between 50% and 100% of the calculated delay
    return Math.floor(cappedDelay * (0.5 + Math.random() * 0.5));
  }

  return cappedDelay;
}

/**
 * Wrapper around llmApi.chatCompletionStream with exponential backoff retry logic
 */
export async function chatCompletionStreamWithBackoff(
  llmApi: BaseLlmApi,
  params: ChatCompletionCreateParamsStreaming,
  abortSignal: AbortSignal,
  options: ExponentialBackoffOptions = {},
): Promise<AsyncGenerator<any>> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: any;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      // Check if we should abort before making the request
      if (abortSignal.aborted) {
        throw new Error("Request aborted");
      }

      // OpenAIApi switches to the Responses API itself, and only for the official
      // endpoint, so gpt-5 names behind proxies keep using Chat Completions
      return llmApi.chatCompletionStream(params, abortSignal);
    } catch (err: any) {
      lastError = err;

      // Don't retry if the request was aborted
      if (abortSignal.aborted) {
        throw err;
      }

      // Don't retry on the last attempt
      if (attempt === opts.maxRetries) {
        break;
      }

      // Only retry if the error is retryable
      if (!isRetryableError(err)) {
        // Log full error details for non-retryable errors
        logger.error("Non-retryable LLM API error", err, {
          status: err.status,
          statusText: err.statusText,
          message: err.message,
          error: err.error,
          model: params.model,
        });
        throw err;
      }

      const delay = calculateDelay(attempt, opts);

      // Only log retry attempts after the first hiddenRetries attempts
      if (attempt >= opts.hiddenRetries) {
        warn(
          `Retrying LLM API call (attempt ${attempt + 1 - opts.hiddenRetries}/${
            opts.maxRetries + 1 - opts.hiddenRetries
          }) after ${delay}ms delay. Error: ${err.message}`,
        );
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // If we get here, all retries failed
  error(
    `LLM API call failed after ${opts.maxRetries + 1} attempts. Last error: ${
      lastError.message
    }`,
  );
  throw lastError;
}

/**
 * Logs a retry and waits before it. A stream that died after it started is
 * always reported, with the provider's message; a failure to open is reported
 * after the first hidden retries.
 */
async function waitBeforeRetry(
  attempt: number,
  opts: Required<ExponentialBackoffOptions>,
  err: any,
  streamStarted: boolean,
): Promise<void> {
  const delay = calculateDelay(attempt, opts);
  logger.debug("Retry attempt", { attempt, delay, error: err.message });
  if (streamStarted) {
    warn(
      `Provider stream failed, retrying the request. Error: ${formatError(err)}`,
    );
  } else if (attempt >= opts.hiddenRetries) {
    warn(
      `Retrying request (${attempt + 1 - opts.hiddenRetries}/${
        opts.maxRetries + 1 - opts.hiddenRetries
      }). Error: ${formatError(err)}`,
    );
  }
  logger.debug("Waiting before retry", { delayMs: delay });
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/** Observers for each attempt of a retried stream. */
export interface StreamAttemptHooks<T> {
  /** Every chunk as it arrives, before it is held for the attempt */
  onChunk?: (chunk: T) => void;
  /**
   * An attempt that produced chunks and then failed. Its chunks are never
   * yielded, but the provider may already have billed them.
   */
  onDiscardedAttempt?: (chunks: T[], error: unknown) => void;
}

/**
 * Wraps an async generator with exponential backoff retry logic.
 * Chunks from an attempt are yielded only after that attempt finishes, so a
 * retry replaces a failed attempt instead of appending to it. A stream that
 * already produced a token is retried at most twice.
 */
export async function* withExponentialBackoff<T>(
  generatorFactory: (
    retryAbortSignal: AbortSignal,
  ) => Promise<AsyncGenerator<T>>,
  abortSignal: AbortSignal,
  options: ExponentialBackoffOptions = {},
  hooks: StreamAttemptHooks<T> = {},
): AsyncGenerator<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: any;
  let unfinishedStreamRetries = 0;
  let attempts = 0;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    attempts++;
    // Create a new AbortController for this retry attempt
    // This prevents accumulating listeners on the original signal
    const retryAbortController = new AbortController();

    // Forward abort from the original signal to the retry signal
    const abortListener = () => {
      retryAbortController.abort();
    };

    if (abortSignal.aborted) {
      retryAbortController.abort();
    } else if (typeof abortSignal.addEventListener === "function") {
      abortSignal.addEventListener("abort", abortListener);
    }

    // Held until this attempt finishes, so a retry does not append to it
    const buffered: T[] = [];
    let receivedChunk = false;

    try {
      // Check if we should abort before creating the generator
      if (abortSignal.aborted) {
        throw new Error("Request aborted");
      }

      const generator = await generatorFactory(retryAbortController.signal);

      for await (const chunk of generator) {
        // Check abort signal during iteration
        if (abortSignal.aborted) {
          throw new Error("Request aborted");
        }

        receivedChunk = true;
        hooks.onChunk?.(chunk);
        buffered.push(chunk);
      }

      // Clean up the abort listener since we succeeded
      if (typeof abortSignal.removeEventListener === "function") {
        abortSignal.removeEventListener("abort", abortListener);
      }

      for (const chunk of buffered) {
        yield chunk;
      }
      return;
    } catch (err: any) {
      lastError = err;
      if (buffered.length > 0) {
        hooks.onDiscardedAttempt?.(buffered, err);
      }

      // Clean up the abort listener
      if (typeof abortSignal.removeEventListener === "function") {
        abortSignal.removeEventListener("abort", abortListener);
      }

      // Don't retry if the request was aborted
      if (abortSignal.aborted) {
        throw err;
      }

      // A stream that already produced a token is retried on any provider
      // failure. One that has not opened yet keeps the setup allow-list.
      const retryable = receivedChunk
        ? isUnfinishedStreamError(err)
        : isRetryableError(err);
      if (!retryable) {
        throw err;
      }

      if (receivedChunk) {
        if (unfinishedStreamRetries >= MAX_UNFINISHED_STREAM_RETRIES) {
          break;
        }
        unfinishedStreamRetries++;
      } else if (attempt === opts.maxRetries) {
        break;
      }

      await waitBeforeRetry(attempt, opts, err, receivedChunk);
    }
  }

  // If we get here, all retries failed
  error(`Failed after ${attempts} attempts. Last error: ${lastError.message}`);
  throw lastError;
}
