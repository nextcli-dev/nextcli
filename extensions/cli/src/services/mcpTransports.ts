import { Agent as HttpsAgent } from "https";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { MCPServer } from "@nextcli/config-yaml";

import { MCPConnectionInfo } from "./types.js";

// The package root exports only the MCPServer union, so derive the variants
type StdioMcpServer = Extract<MCPServer, { command: string }>;
type SseMcpServer = Extract<MCPServer, { url: string }>;
type HttpMcpServer = SseMcpServer;

export function constructSseTransport(
  serverConfig: SseMcpServer,
  apiKey: string | undefined,
  authProvider?: OAuthClientProvider,
): SSEClientTransport {
  const sseAgent =
    serverConfig.requestOptions?.verifySsl === false
      ? new HttpsAgent({ rejectUnauthorized: false })
      : undefined;

  const headers = {
    ...serverConfig.requestOptions?.headers,
    ...(apiKey && {
      Authorization: `Bearer ${apiKey}`,
    }),
  };

  return new SSEClientTransport(new URL(serverConfig.url), {
    eventSourceInit: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...init?.headers,
            ...headers,
          },
          ...(sseAgent && { agent: sseAgent }),
        }),
    },
    requestInit: {
      headers,
      ...(sseAgent && { agent: sseAgent }),
    },
    ...(authProvider && { authProvider }),
  });
}

export function constructHttpTransport(
  serverConfig: HttpMcpServer,
  apiKey: string | undefined,
  authProvider?: OAuthClientProvider,
): StreamableHTTPClientTransport {
  const streamableAgent =
    serverConfig.requestOptions?.verifySsl === false
      ? new HttpsAgent({ rejectUnauthorized: false })
      : undefined;

  const headers = {
    ...serverConfig.requestOptions?.headers,
    ...(apiKey && {
      Authorization: `Bearer ${apiKey}`,
    }),
  };

  return new StreamableHTTPClientTransport(new URL(serverConfig.url), {
    requestInit: {
      headers,
      ...(streamableAgent && { agent: streamableAgent }),
    },
    ...(authProvider && { authProvider }),
  });
}

export function constructStdioTransport(
  serverConfig: StdioMcpServer,
  connection: MCPConnectionInfo,
): StdioClientTransport {
  const env: Record<string, string> = serverConfig.env || {};
  if (process.env) {
    for (const [key, value] of Object.entries(process.env)) {
      if (!(key in env) && !!value) {
        env[key] = value;
      }
    }
  }

  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args || [],
    env,
    cwd: serverConfig.cwd,
    stderr: "pipe",
  });

  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on("data", (data: Buffer) => {
      const stderrOutput = data.toString().trim();
      if (stderrOutput) {
        connection.warnings.push(stderrOutput);
      }
    });
  }

  return transport;
}
