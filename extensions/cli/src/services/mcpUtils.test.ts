import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

import { isAuthError, isMethodNotAllowed } from "./mcpUtils.js";

describe("isAuthError", () => {
  it("accepts the SDK's UnauthorizedError", () => {
    expect(isAuthError(new UnauthorizedError())).toBe(true);
  });

  it("accepts HTTP and SSE 401 errors", () => {
    expect(isAuthError(new StreamableHTTPError(401, "Unauthorized"))).toBe(
      true,
    );
    expect(
      isAuthError(new SseError(401, "Unauthorized", undefined as never)),
    ).toBe(true);
  });

  // A 405 also means "use SSE" for SSE-only servers; MCPService only signs in
  // on a 405 when the server publishes OAuth metadata (isMethodNotAllowed).
  it("rejects 405 and other status codes", () => {
    expect(isAuthError(new StreamableHTTPError(405, "Not allowed"))).toBe(
      false,
    );
    expect(
      isAuthError(new SseError(405, "Not allowed", undefined as never)),
    ).toBe(false);
    expect(isAuthError(new StreamableHTTPError(500, "401 in text"))).toBe(
      false,
    );
  });

  it("does not match on message text", () => {
    expect(isAuthError(new Error("connect ECONNREFUSED 127.0.0.1:4051"))).toBe(
      false,
    );
    expect(isAuthError(new Error("Unauthorized"))).toBe(false);
    expect(isAuthError(new Error("HTTP 401"))).toBe(false);
    expect(isAuthError("401")).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

describe("isMethodNotAllowed", () => {
  it("accepts HTTP and SSE 405 errors only", () => {
    expect(
      isMethodNotAllowed(new StreamableHTTPError(405, "Not allowed")),
    ).toBe(true);
    expect(
      isMethodNotAllowed(new SseError(405, "Not allowed", undefined as never)),
    ).toBe(true);
    expect(isMethodNotAllowed(new StreamableHTTPError(401, "x"))).toBe(false);
    expect(isMethodNotAllowed(new Error("405"))).toBe(false);
  });
});
