import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  SseError,
  type SSEClientTransport,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPError,
  type StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Check whether an error from an HTTP/SSE MCP transport means the server
 * requires authorization. Only typed SDK errors count: matching on message
 * text would misfire on unrelated errors that happen to contain "401".
 */
export function isAuthError(error: unknown): boolean {
  return (
    error instanceof UnauthorizedError ||
    ((error instanceof SseError || error instanceof StreamableHTTPError) &&
      error.code === 401)
  );
}

/**
 * A 405 from a remote transport. Some servers (Sanity) answer unauthenticated
 * requests with 405 instead of 401. It also means "wrong transport" for
 * SSE-only servers, so it is not an auth error by itself: the caller tries
 * an OAuth sign-in only when the server publishes OAuth metadata.
 */
export function isMethodNotAllowed(error: unknown): boolean {
  return (
    (error instanceof SseError || error instanceof StreamableHTTPError) &&
    error.code === 405
  );
}

/**
 * An auth failure from a remote transport, carrying the transport that saw it
 * so the OAuth authorization code can be exchanged on it (`finishAuth`).
 */
export class McpAuthRequiredError extends Error {
  constructor(
    public readonly transport:
      | SSEClientTransport
      | StreamableHTTPClientTransport,
    cause: unknown,
  ) {
    super(
      `Authorization required: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
