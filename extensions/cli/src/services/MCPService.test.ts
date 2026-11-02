import * as http from "http";
import type { AddressInfo } from "net";

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getMcpOAuthStoragePath } from "./mcpOAuth.js";
import { MCPService } from "./MCPService.js";
import type { AssistantConfig } from "./types.js";

// Mock the MCP SDK
const mockClient = {
  connect: vi.fn(),
  getServerCapabilities: vi.fn(() => ({ prompts: true, tools: true })),
  listPrompts: vi.fn(() => Promise.resolve({ prompts: [] })),
  listTools: vi.fn(() => Promise.resolve({ tools: [] })),
  callTool: vi.fn(() => Promise.resolve({})),
  close: vi.fn(() => Promise.resolve()),
};

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(() => mockClient),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(),
}));

// Keep the real error classes (SseError, StreamableHTTPError) that
// isAuthError checks against; only the transports are mocked.
vi.mock("@modelcontextprotocol/sdk/client/sse.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  SSEClientTransport: vi.fn(),
}));

vi.mock(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    StreamableHTTPClientTransport: vi.fn(),
  }),
);

vi.mock("https", () => ({
  Agent: vi.fn().mockImplementation(() => ({
    rejectUnauthorized: false,
  })),
}));

describe("MCPService", () => {
  let mcpService: MCPService;
  let mockAssistant: AssistantConfig;

  beforeEach(() => {
    mcpService = new MCPService();
    mockAssistant = {
      name: "Test Config",
      version: "1.0.0",
      mcpServers: [
        {
          name: "test-server",
          command: "npx",
          args: ["-v"],
          env: { TEST: "value" },
        },
      ],
    } as AssistantConfig;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await mcpService.cleanup();
  });

  describe("initialization", () => {
    it("should initialize with empty state", () => {
      const state = mcpService.getState();
      expect(mcpService.isReady()).toBe(false);
      expect(state.connections).toEqual([]);
      expect(state.tools.length).toBe(0);
      expect(state.prompts.length).toBe(0);
    });

    it("should initialize with no servers", async () => {
      const emptyAssistant = {
        name: "empty",
        version: "1.0.0",
      } as AssistantConfig;
      const state = await mcpService.initialize(emptyAssistant);

      expect(mcpService.isReady()).toBe(true);
      expect(state.connections).toEqual([]);
      expect(state.tools.length).toBe(0);
      expect(state.prompts.length).toBe(0);
    });

    it("should initialize and return immediately even with server configs", async () => {
      const state = await mcpService.initialize(mockAssistant);

      // Should return immediately with ready state
      expect(mcpService.isReady()).toBe(true);
      expect(state.mcpService).toBe(mcpService);
    });
  });

  describe("service management", () => {
    beforeEach(async () => {
      await mcpService.initialize(mockAssistant);
    });

    it("should get overall status", async () => {
      const firstStatus = mcpService.getOverallStatus();
      expect(firstStatus.status).toBe("connected");
      expect(firstStatus.hasWarnings).toBe(false);
      await mcpService.cleanup();
      const secondStatus = mcpService.getOverallStatus();
      expect(secondStatus.status).toBe("idle");
    });
  });

  describe("server management", () => {
    beforeEach(async () => {
      await mcpService.initialize(mockAssistant);
    });

    it("should handle restart all servers", async () => {
      await expect(mcpService.restartAllServers()).resolves.not.toThrow();
    });

    it("should handle stop all servers", async () => {
      await expect(mcpService.shutdownConnections()).resolves.not.toThrow();
    });

    it("should handle server not found error", async () => {
      await expect(mcpService.restartServer("nonexistent")).rejects.toThrow(
        "Server nonexistent not found in configuration",
      );
    });

    it("should handle stop individual server", async () => {
      await expect(mcpService.stopServer("test-server")).resolves.not.toThrow();
    });
  });

  describe("tools and prompts", () => {
    beforeEach(async () => {
      await mcpService.initialize(mockAssistant);
    });

    it("should return empty arrays for tools and prompts initially", () => {
      expect(Array.isArray(mcpService.getState().tools)).toBe(true);
      expect(Array.isArray(mcpService.getState().tools)).toBe(true);
    });

    it("should throw error for unknown tool", async () => {
      await expect(mcpService.runTool("unknown-tool", {})).rejects.toThrow(
        "Tool unknown-tool not found",
      );
    });
  });

  describe("shutdown", () => {
    it("should handle shutdown gracefully", async () => {
      await mcpService.initialize(mockAssistant);
      await mcpService.cleanup();

      const state = mcpService.getState();
      expect(
        state.mcpService
          ?.getState()
          .connections.filter((c) => c.status === "connected"),
      ).toHaveLength(0);
    });

    it("should handle multiple shutdown calls", async () => {
      await mcpService.initialize(mockAssistant);
      await mcpService.cleanup();
      await expect(mcpService.cleanup()).resolves.not.toThrow();
    });
  });

  describe("transport types", () => {
    it("should support SSE transport", async () => {
      const sseAssistant: AssistantConfig = {
        name: "sse-assistant",
        version: "1.0.0",
        mcpServers: [
          {
            name: "sse-server",
            type: "sse",
            url: "https://example.com/sse",
          },
        ],
      } as AssistantConfig;

      await expect(mcpService.initialize(sseAssistant)).resolves.not.toThrow();
    });

    it("should support streamable-http transport", async () => {
      const httpAssistant: AssistantConfig = {
        name: "http-assistant",
        version: "1.0.0",
        mcpServers: [
          {
            name: "http-server",
            type: "streamable-http",
            url: "https://example.com/http",
          },
        ],
      } as AssistantConfig;

      await expect(mcpService.initialize(httpAssistant)).resolves.not.toThrow();
    });

    it("should default to stdio transport when type is not specified", async () => {
      const defaultAssistant: AssistantConfig = {
        name: "Default Config",
        version: "1.0.0",
        mcpServers: [
          {
            name: "default-server",
            command: "npx",
            args: ["-v"],
          },
        ],
      } as AssistantConfig;

      await expect(
        mcpService.initialize(defaultAssistant),
      ).resolves.not.toThrow();
    });

    it("should create HttpsAgent when verifySsl is false for SSE transport", async () => {
      const { SSEClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/sse.js"
      );
      const { Agent: HttpsAgent } = await import("https");

      const sseAssistant: AssistantConfig = {
        name: "sse-assistant",
        version: "1.0.0",
        mcpServers: [
          {
            name: "sse-server",
            type: "sse",
            url: "https://example.com/sse",
            requestOptions: {
              verifySsl: false,
            },
          },
        ],
      } as AssistantConfig;

      await mcpService.initialize(sseAssistant);

      expect(SSEClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          eventSourceInit: expect.objectContaining({
            fetch: expect.any(Function),
          }),
          requestInit: expect.objectContaining({
            agent: expect.any(Object),
          }),
        }),
      );
      expect(HttpsAgent).toHaveBeenCalledWith({
        rejectUnauthorized: false,
      });
    });

    it("should not create HttpsAgent when verifySsl is true for SSE transport", async () => {
      const { SSEClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/sse.js"
      );
      const { Agent: HttpsAgent } = await import("https");

      const sseAssistant: AssistantConfig = {
        name: "sse-assistant",
        version: "1.0.0",
        mcpServers: [
          {
            name: "sse-server",
            type: "sse",
            url: "https://example.com/sse",
            requestOptions: {
              verifySsl: true,
            },
          },
        ],
      } as AssistantConfig;

      await mcpService.initialize(sseAssistant);

      expect(SSEClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          eventSourceInit: expect.objectContaining({
            fetch: expect.any(Function),
          }),
          requestInit: expect.objectContaining({
            headers: {},
          }),
        }),
      );
      expect(SSEClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        expect.not.objectContaining({
          requestInit: expect.objectContaining({
            agent: expect.anything(),
          }),
        }),
      );
      expect(HttpsAgent).not.toHaveBeenCalled();
    });

    it("should create HttpsAgent when verifySsl is false for streamable-http transport", async () => {
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      const { Agent: HttpsAgent } = await import("https");

      const httpAssistant: AssistantConfig = {
        name: "http-assistant",
        version: "1.0.0",
        mcpServers: [
          {
            name: "http-server",
            type: "streamable-http",
            url: "https://example.com/http",
            requestOptions: {
              verifySsl: false,
            },
          },
        ],
      } as AssistantConfig;

      await mcpService.initialize(httpAssistant);

      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          requestInit: expect.objectContaining({
            agent: expect.any(Object),
          }),
        }),
      );
      expect(HttpsAgent).toHaveBeenCalledWith({
        rejectUnauthorized: false,
      });
    });

    it("should not create HttpsAgent when verifySsl is true for streamable-http transport", async () => {
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      const { Agent: HttpsAgent } = await import("https");

      const httpAssistant: AssistantConfig = {
        name: "http-assistant",
        version: "1.0.0",
        mcpServers: [
          {
            name: "http-server",
            type: "streamable-http",
            url: "https://example.com/http",
            requestOptions: {
              verifySsl: true,
            },
          },
        ],
      } as AssistantConfig;

      await mcpService.initialize(httpAssistant);

      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          requestInit: expect.objectContaining({
            headers: {},
          }),
        }),
      );
      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        expect.not.objectContaining({
          requestInit: expect.objectContaining({
            agent: expect.anything(),
          }),
        }),
      );
      expect(HttpsAgent).not.toHaveBeenCalled();
    });

    it("should not create HttpsAgent when verifySsl is not specified", async () => {
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      const { Agent: HttpsAgent } = await import("https");

      const httpAssistant: AssistantConfig = {
        name: "http-assistant",
        version: "1.0.0",
        mcpServers: [
          {
            name: "http-server",
            type: "streamable-http",
            url: "https://example.com/http",
          },
        ],
      } as AssistantConfig;

      await mcpService.initialize(httpAssistant);

      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          requestInit: expect.objectContaining({
            headers: {},
          }),
        }),
      );
      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        expect.not.objectContaining({
          requestInit: expect.objectContaining({
            agent: expect.anything(),
          }),
        }),
      );
      expect(HttpsAgent).not.toHaveBeenCalled();
    });
  });

  describe("OAuth for remote servers", () => {
    const oauthAssistant = (
      server: Record<string, unknown> = {},
    ): AssistantConfig =>
      ({
        name: "oauth-assistant",
        version: "1.0.0",
        mcpServers: [
          {
            name: "oauth-server",
            type: "streamable-http",
            url: "https://mcp.example.com/mcp",
            ...server,
          },
        ],
      }) as AssistantConfig;

    let transports: Array<{ opts: any; finishAuth: ReturnType<typeof vi.fn> }>;

    beforeEach(async () => {
      const probe = http.createServer();
      await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
      const { port } = probe.address() as AddressInfo;
      await new Promise<void>((r) => probe.close(() => r()));
      process.env.NEXTCLI_MCP_OAUTH_PORT = String(port);

      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      transports = [];
      vi.mocked(StreamableHTTPClientTransport).mockImplementation(function (
        this: any,
        _url: URL,
        opts: any,
      ) {
        this.opts = opts;
        this.finishAuth = vi.fn(async () => {});
        transports.push(this);
      } as any);
    });

    afterEach(async () => {
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      vi.mocked(StreamableHTTPClientTransport).mockReset();
      mockClient.connect.mockReset();
      delete process.env.NEXTCLI_MCP_OAUTH_PORT;
      const fs = await import("fs");
      fs.rmSync(getMcpOAuthStoragePath(), { force: true });
    });

    function hitCallback(query: string) {
      return new Promise<void>((resolve, reject) => {
        http
          .get(
            `http://127.0.0.1:${process.env.NEXTCLI_MCP_OAUTH_PORT}/oauth/callback?${query}`,
            (res) => {
              res.resume();
              res.on("end", () => resolve());
            },
          )
          .on("error", reject);
      });
    }

    it("signs in through the browser instead of spawning mcp-remote", async () => {
      const open = (await import("open")).default as unknown as ReturnType<
        typeof vi.fn
      >;
      const { StdioClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/stdio.js"
      );

      let state = "";
      // Simulate the browser completing sign-in as soon as it is opened.
      open.mockImplementationOnce(async () => {
        await hitCallback(`code=the-code&state=${state}`);
      });
      // First connect: the SDK starts OAuth and throws UnauthorizedError.
      mockClient.connect.mockImplementationOnce(async (transport: any) => {
        const provider = transport.opts.authProvider;
        state = await provider.state();
        await provider.redirectToAuthorization(
          new URL("https://auth.example.com/authorize"),
        );
        throw new UnauthorizedError();
      });
      // Second connect (with tokens) succeeds.
      mockClient.connect.mockResolvedValueOnce(undefined);

      await mcpService.initialize(oauthAssistant(), true, false);

      const conn = mcpService.getState().connections[0];
      expect(conn.status).toBe("connected");
      expect(conn.warnings).toEqual([]);
      expect(open).toHaveBeenCalledWith("https://auth.example.com/authorize");
      expect(transports[0].finishAuth).toHaveBeenCalledWith("the-code");
      expect(transports).toHaveLength(2);
      expect(transports[1].opts.authProvider).toBe(
        transports[0].opts.authProvider,
      );
      expect(StdioClientTransport).not.toHaveBeenCalled();
    });

    it("fails with a sign-in message in headless mode without stored tokens", async () => {
      const open = (await import("open")).default as unknown as ReturnType<
        typeof vi.fn
      >;
      const { StdioClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/stdio.js"
      );
      const { StreamableHTTPError } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      mockClient.connect.mockRejectedValueOnce(
        new StreamableHTTPError(401, "Unauthorized"),
      );

      await expect(
        mcpService.initialize(oauthAssistant(), false, true),
      ).rejects.toThrow(/oauth-server.*requires OAuth sign-in/);
      expect(transports[0].opts.authProvider).toBeUndefined();
      expect(open).not.toHaveBeenCalled();
      expect(StdioClientTransport).not.toHaveBeenCalled();
    });

    it("does not attach OAuth when an apiKey or Authorization header is set", async () => {
      mockClient.connect.mockResolvedValue(undefined);

      await mcpService.initialize(oauthAssistant({ apiKey: "key" }), true);
      await mcpService.initialize(
        oauthAssistant({
          requestOptions: { headers: { authorization: "Bearer x" } },
        }),
        true,
      );

      expect(transports).toHaveLength(2);
      for (const t of transports) {
        expect(t.opts.authProvider).toBeUndefined();
      }
    });

    it("does not treat unrelated errors mentioning 401 as auth errors", async () => {
      const { SSEClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/sse.js"
      );
      mockClient.connect.mockRejectedValue(
        new Error("connect ECONNREFUSED 127.0.0.1:4010"),
      );

      await mcpService.initialize(
        oauthAssistant({ type: undefined }),
        true,
        false,
      );

      const conn = mcpService.getState().connections[0];
      expect(conn.status).toBe("error");
      expect(conn.error).toContain("ECONNREFUSED");
      // HTTP attempt, then the normal SSE fallback; no OAuth wait.
      expect(SSEClientTransport).toHaveBeenCalled();
    });
  });
});
