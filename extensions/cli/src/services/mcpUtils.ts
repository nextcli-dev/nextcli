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
