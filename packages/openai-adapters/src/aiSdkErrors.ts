/**
 * Error messages for failed AI SDK calls, in the shape the rest of NextCLI
 * already uses for HTTP errors (BaseLLM.parseError in core): the status and
 * the URL first, then a blank line and the response body.
 * gui/src/util/errorAnalysis.ts reads the status from "HTTP <code>" and
 * parses the body after the blank line, so a 404 reads as a missing route on
 * that host rather than a bare "Not Found".
 */

type ApiCallErrorLike = {
  name?: string;
  message: string;
  url?: string;
  statusCode?: number;
  responseBody?: string;
};

/**
 * The error to throw for a failed AI SDK call. Aborts and errors that aren't
 * HTTP errors are returned as they are.
 */
export function formatAiSdkError(error: unknown): unknown {
  // Checked by name, so this file doesn't load the `ai` package
  const retry = error as { name?: string; lastError?: unknown } | undefined;
  const cause = (
    retry?.name === "AI_RetryError" ? (retry.lastError ?? error) : error
  ) as ApiCallErrorLike | undefined;
  if (cause?.name !== "AI_APICallError") {
    return cause;
  }
  const status = cause.statusCode ?? "error";
  const where = cause.url ? ` from ${cause.url}` : "";
  const body = cause.responseBody?.trim() || cause.message;
  const formatted = new Error(`HTTP ${status}${where}\n\n${body}`);
  (formatted as Error & { cause?: unknown }).cause = cause;
  return formatted;
}
