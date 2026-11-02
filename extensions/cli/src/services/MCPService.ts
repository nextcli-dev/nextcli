import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { decodeFQSN, getTemplateVariables } from "@nextcli/config-yaml";

import { getErrorString } from "../util/error.js";
import { logger } from "../util/logger.js";

import { BaseService, ServiceWithDependencies } from "./BaseService.js";
import {
  cancelAllMcpOAuthFlows,
  CliMcpOAuthProvider,
  hasStoredMcpOAuthTokens,
} from "./mcpOAuth.js";
import {
  constructHttpTransport,
  constructSseTransport,
  constructStdioTransport,
} from "./mcpTransports.js";
import { isAuthError, McpAuthRequiredError } from "./mcpUtils.js";
import { serviceContainer } from "./ServiceContainer.js";
import type { AssistantConfig } from "./types.js";
import {
  MCPConnectionInfo,
  MCPServerConfig,
  MCPServiceState,
  SERVICE_NAMES,
} from "./types.js";

interface ServerConnection extends MCPConnectionInfo {
  client: Client | null;
}

export const EMPTY_MCP_STATE: MCPServiceState = {
  mcpService: null,
  connections: [],
  tools: [],
  prompts: [],
};

export class MCPService
  extends BaseService<MCPServiceState>
  implements ServiceWithDependencies
{
  private connections: Map<string, ServerConnection> = new Map();
  private assistant: AssistantConfig | null = null;
  private isShuttingDown = false;
  private isHeadless: boolean | undefined;
  private apiKeyCache: Map<string, string> = new Map();

  getDependencies(): string[] {
    return [SERVICE_NAMES.CONFIG, SERVICE_NAMES.AUTH];
  }
  constructor() {
    super("MCPService", {
      ...EMPTY_MCP_STATE,
    });

    // Register shutdown handler
    process.on("exit", () => this.cleanup());
    process.on("SIGINT", () => this.cleanup());
    process.on("SIGTERM", () => this.cleanup());
  }

  /**
   * Initialize the MCP service
   */
  async doInitialize(
    assistant: AssistantConfig,
    hasAgentFile: boolean,
    isHeadless: boolean | undefined,
  ): Promise<MCPServiceState> {
    this.isHeadless = isHeadless;

    await this.shutdownConnections();

    this.assistant = assistant;
    this.connections.clear();

    const connectionPromises = assistant.mcpServers?.map(async (config) => {
      if (config) {
        return await this.connectServer(config);
      }
    });

    const connectionInit = Promise.all(connectionPromises ?? []);
    if (isHeadless || hasAgentFile) {
      await connectionInit;

      if (isHeadless) {
        // With headless or agent, throw error if any MCP server failed to connect
        const failedConnections = Array.from(this.connections.values()).filter(
          (c) => c.status === "error",
        );
        if (failedConnections.length > 0) {
          const errorMessages = failedConnections.map(
            (c) => `${c.config?.name}: ${c.error}`,
          );
          throw new Error(
            `MCP server(s) failed to load:\n${errorMessages.join("\n")}`,
          );
        }
      }
    } else {
      this.updateState();
    }

    return this.currentState;
  }

  /**
   * Update internal state based on current connections
   */
  private updateState() {
    const connections: MCPConnectionInfo[] = Array.from(
      this.connections.values(),
    ).map(({ client: _, ...rest }) => rest);
    const connectedServers = connections.filter(
      (c) => c.status === "connected",
    );
    const tools = connectedServers.flatMap((s) => s.tools);
    const prompts = connectedServers.flatMap((s) => s.prompts);

    const newState: MCPServiceState = {
      mcpService: this,
      connections,
      tools,
      prompts,
    };
    this.setState(newState);
    serviceContainer.set(SERVICE_NAMES.MCP, newState);
  }

  /**
   * Get current MCP service state
   */
  getState(): MCPServiceState {
    return { ...this.currentState };
  }

  /**
   * Get overall status for UI indicator
   */
  getOverallStatus(): {
    status: "idle" | "connecting" | "connected" | "error";
    hasWarnings: boolean;
  } {
    const connections = Array.from(this.connections.values());
    const hasWarnings = connections.some((c) => c.warnings.length > 0);

    if (connections.some((c) => c.status === "connecting")) {
      return { status: "connecting", hasWarnings };
    }
    if (connections.some((c) => c.status === "error")) {
      return { status: "error", hasWarnings };
    }
    if (connections.some((c) => c.status === "connected")) {
      return { status: "connected", hasWarnings };
    }

    return { status: "idle", hasWarnings };
  }

  /**
   * Generic wrapper for client operations that handles 401 errors with token refresh
   * Only applies to SSE/HTTP connections, not stdio
   */
  private async withTokenRefresh<T>(
    serverName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`Connection ${serverName} not found`);
    }

    const serverConfig = connection.config;
    if (!serverConfig || "command" in serverConfig) {
      // For stdio connections, just execute normally (no token refresh possible)
      return await operation();
    }

    // No auth/token refresh available - just execute the operation directly
    return await operation();
  }

  /**
   * Run a tool by name
   */
  public async runTool(name: string, args: Record<string, any>) {
    for (const connection of this.connections.values()) {
      if (connection.status === "connected" && connection.client) {
        const tool = connection.tools.find((t) => t.name === name);
        if (tool) {
          const serverName = connection.config!.name;
          return await this.withTokenRefresh(serverName, async () => {
            const conn = this.connections.get(serverName);
            if (!conn?.client) {
              throw new Error(`Client for ${serverName} not available`);
            }
            return await conn.client.callTool({
              name,
              arguments: args,
            });
          });
        }
      }
    }
    throw new Error(`Tool ${name} not found`);
  }

  /**
   * Restart all servers
   */
  public async restartAllServers(): Promise<void> {
    if (!this.assistant) return;

    await this.shutdownConnections();
    await this.initialize(this.assistant);
  }

  /**
   * Restart a specific server
   */
  public async restartServer(serverName: string): Promise<void> {
    if (!this.assistant || !this.assistant.mcpServers) return;

    const serverConfig = this.assistant.mcpServers.find(
      (s, index) => s && (s.name || `server-${index}`) === serverName,
    );

    if (!serverConfig) {
      throw new Error(`Server ${serverName} not found in configuration`);
    }

    const existingConnection = this.connections.get(serverName);
    if (existingConnection) {
      if (existingConnection.status === "connected") {
        await this.shutdownConnection(existingConnection);
      }
      this.connections.delete(serverName);
    }
    await this.connectServer(serverConfig);
  }

  private async connectServer(serverConfig: MCPServerConfig) {
    const connection: ServerConnection = {
      config: serverConfig,
      client: null,
      prompts: [],
      tools: [],
      status: "connecting",
      warnings: [],
    };
    const serverName = serverConfig.name;
    this.connections.set(serverName, connection);
    this.updateState();

    const vars = getTemplateVariables(JSON.stringify(serverConfig));
    const secretVars = vars.filter((v) => v.startsWith("secrets."));
    const unrendered = secretVars.map((v) => {
      return decodeFQSN(v.replace("secrets.", "")).secretName;
    });

    try {
      if (unrendered.length > 0) {
        const message = `${serverConfig.name} MCP Server has unresolved secrets: ${unrendered.join(", ")}
For personal use you can set the secret in the hub at https://nextcli.dev/settings/secrets or pass it to the CLI environment.
Org-level secrets can only be used for MCP by Background Agents (https://docs.nextcli.dev/hub/agents/overview) when \"Include in Env\" is enabled for the secret.`;
        if (this.isHeadless) {
          throw new Error(message);
        } else {
          connection.warnings.push(message);
        }
      }

      const client = await this.getConnectedClient(serverConfig, connection);

      connection.client = client;
      connection.status = "connected";
      this.updateState();

      const capabilities = client.getServerCapabilities();

      if (capabilities?.prompts) {
        try {
          connection.prompts = await this.withTokenRefresh(
            serverName,
            async () => {
              const conn = this.connections.get(serverName);
              if (!conn?.client) {
                throw new Error(`Client for ${serverName} not available`);
              }
              return (await conn.client.listPrompts()).prompts;
            },
          );
        } catch (error) {
          const errorMessage = getErrorString(error);
          connection.warnings.push(`Failed to load prompts: ${errorMessage}`);
          logger.warn("Failed to load MCP prompts", {
            name: serverName,
            error: errorMessage,
          });
        }
      }

      if (capabilities?.tools) {
        try {
          connection.tools = await this.withTokenRefresh(
            serverName,
            async () => {
              const conn = this.connections.get(serverName);
              if (!conn?.client) {
                throw new Error(`Client for ${serverName} not available`);
              }
              return (await conn.client.listTools()).tools;
            },
          );
        } catch (error) {
          const errorMessage = getErrorString(error);
          connection.warnings.push(`Failed to load tools: ${errorMessage}`);
          logger.warn("Failed to load MCP tools", {
            name: serverName,
            error: errorMessage,
          });
        }
      }
    } catch (error) {
      const errorMessage = getErrorString(error);
      connection.status = "error";

      // Convert any warnings to error at time of connection failure
      if (connection.warnings.length > 0) {
        const stderrContent = connection.warnings.join("\n");
        connection.error = `${errorMessage}\n\nServer stderr:\n${stderrContent}`;
        connection.warnings = [];
      } else {
        connection.error = errorMessage;
      }

      logger.error("Failed to connect to MCP server", {
        name: serverName,
        error: connection.error,
      });
    }

    this.updateState();
  }

  /**
   * Stop a specific server
   */
  public async stopServer(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (connection) {
      await this.shutdownConnection(connection);
    }
  }

  /**
   * Shutdown all connections
   */
  public async shutdownConnections(): Promise<void> {
    const shutdownPromises = Array.from(this.connections.values()).map(
      (connection) => this.shutdownConnection(connection),
    );
    await Promise.all(shutdownPromises);
    this.updateState();
  }

  /**
   * Shutdown a single connection
   */
  private async shutdownConnection(
    connection: ServerConnection,
  ): Promise<void> {
    try {
      if (connection.client) {
        await connection.client.close();
      }
      connection.status = "idle";
      connection.warnings = [];
      connection.client = null;
      connection.tools = [];
      connection.prompts = [];
      connection.error = undefined;
      this.updateState();
    } catch (error) {
      const errorMessage = getErrorString(error);
      logger.warn("Error shutting down MCP connection", {
        name: connection.config?.name,
        error: errorMessage,
      });
    }
  }

  public async cleanup(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.removeAllListeners();
    cancelAllMcpOAuthFlows("MCP service shut down");
    await this.shutdownConnections();
  }

  /**
   * Construct transport based on server configuration and connect client
   */
  private async getConnectedClient(
    serverConfig: MCPServerConfig,
    connection: ServerConnection,
  ): Promise<Client> {
    const client = new Client(
      { name: "continue-cli-client", version: "1.0.0" },
      { capabilities: {} },
    );

    if ("command" in serverConfig) {
      // STDIO: no need to check type, just if command is present
      const transport = constructStdioTransport(serverConfig, connection);
      await client.connect(transport, {});
    } else {
      const authProvider = this.createOAuthProvider(serverConfig, connection);
      try {
        await this.withTokenRefresh(serverConfig.name, () =>
          this.connectRemote(serverConfig, client, authProvider),
        );
      } catch (error: unknown) {
        if (!(error instanceof McpAuthRequiredError)) {
          throw error;
        }
        if (!authProvider?.isAuthorizationPending()) {
          throw new Error(
            this.isHeadless
              ? `MCP server "${serverConfig.name}" requires OAuth sign-in. Run cn interactively once to sign in, or set apiKey or an Authorization header in requestOptions.headers.`
              : `MCP server "${serverConfig.name}" requires authorization, and OAuth sign-in could not be started. Set apiKey or an Authorization header in requestOptions.headers.`,
          );
        }
        await this.completeOAuthSignIn(
          serverConfig,
          client,
          authProvider,
          error.transport,
          connection,
        );
      }
    }

    return client;
  }

  /**
   * Create the OAuth provider for a remote server, or undefined when OAuth
   * should not be used: static credentials are configured, or (headless) no
   * stored sign-in exists, so a browser flow could not complete anyway.
   */
  private createOAuthProvider(
    serverConfig: RemoteMcpServerConfig,
    connection: ServerConnection,
  ): CliMcpOAuthProvider | undefined {
    const headers = serverConfig.requestOptions?.headers ?? {};
    const hasStaticAuth =
      !!serverConfig.apiKey ||
      Object.keys(headers).some((h) => h.toLowerCase() === "authorization");
    if (hasStaticAuth) return undefined;
    if (this.isHeadless && !hasStoredMcpOAuthTokens(serverConfig.url)) {
      return undefined;
    }

    return new CliMcpOAuthProvider(serverConfig.url, {
      interactive: !this.isHeadless,
      onAuthorizationUrl: (url) => {
        connection.warnings.push(
          `${OAUTH_WAITING_PREFIX} If the browser did not open, visit: ${url.toString()}`,
        );
        this.updateState();
      },
    });
  }

  /**
   * Connect over SSE/HTTP. If the type isn't explicit, try HTTP and fall back
   * to SSE. Auth failures are wrapped with the transport that saw them so the
   * OAuth code can be exchanged on it.
   */
  private async connectRemote(
    serverConfig: RemoteMcpServerConfig,
    client: Client,
    authProvider: CliMcpOAuthProvider | undefined,
  ): Promise<void> {
    if (serverConfig.apiKey && !this.apiKeyCache.get(serverConfig.name)) {
      this.apiKeyCache.set(serverConfig.name, serverConfig.apiKey);
    }
    const apiKey = this.apiKeyCache.get(serverConfig.name);

    const attempt = async (kind: "sse" | "http") => {
      const transport =
        kind === "sse"
          ? constructSseTransport(serverConfig, apiKey, authProvider)
          : constructHttpTransport(serverConfig, apiKey, authProvider);
      try {
        await client.connect(transport, {});
      } catch (error) {
        if (isAuthError(error)) {
          throw new McpAuthRequiredError(transport, error);
        }
        throw error;
      }
    };

    if (serverConfig.type === "sse") {
      await attempt("sse");
    } else if (serverConfig.type === "streamable-http") {
      await attempt("http");
    } else {
      try {
        await attempt("http");
      } catch (error) {
        if (error instanceof McpAuthRequiredError) {
          throw error;
        }
        await attempt("sse");
      }
    }
  }

  /**
   * Wait for the browser redirect, exchange the code on the transport that
   * started the flow, then reconnect with the new tokens.
   */
  private async completeOAuthSignIn(
    serverConfig: RemoteMcpServerConfig,
    client: Client,
    authProvider: CliMcpOAuthProvider,
    transport: McpAuthRequiredError["transport"],
    connection: ServerConnection,
  ): Promise<void> {
    try {
      const code = await authProvider.waitForAuthorizationCode();
      await transport.finishAuth(code);
    } finally {
      connection.warnings = connection.warnings.filter(
        (w) => !w.startsWith(OAUTH_WAITING_PREFIX),
      );
      this.updateState();
    }

    try {
      await this.connectRemote(serverConfig, client, authProvider);
    } catch (error) {
      if (error instanceof McpAuthRequiredError) {
        throw new Error(
          `MCP server "${serverConfig.name}" still rejected the connection after OAuth sign-in: ${getErrorString(error.cause)}`,
        );
      }
      throw error;
    }
  }
}

type RemoteMcpServerConfig = Exclude<MCPServerConfig, { command: string }>;

const OAUTH_WAITING_PREFIX = "Waiting for OAuth sign-in in your browser.";
