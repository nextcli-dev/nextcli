import {
  AUTO_MODE_POLICIES,
  getPlanModePolicies,
} from "src/permissions/defaultPolicies.js";

import { ensurePermissionsYamlExists } from "../permissions/permissionsYamlLoader.js";
import { resolvePermissionPrecedence } from "../permissions/precedenceResolver.js";
import { commandLineFlagsToPolicies } from "../permissions/toolPattern.js";
import {
  PermissionMode,
  ToolPermissionPolicy,
  ToolPermissions,
} from "../permissions/types.js";
import { BUILT_IN_TOOL_NAMES } from "../tools/builtInToolNames.js";
import { logger } from "../util/logger.js";

import { BaseService, ServiceWithDependencies } from "./BaseService.js";
import { serviceContainer } from "./ServiceContainer.js";
import {
  AgentFileServiceState,
  MCPServiceState,
  SERVICE_NAMES,
} from "./types.js";

export interface InitializeToolServiceOverrides {
  allow?: string[];
  ask?: string[];
  exclude?: string[];
  mode?: PermissionMode;
  isHeadless?: boolean;
}

export interface ToolPermissionServiceState {
  permissions: ToolPermissions;
  currentMode: PermissionMode;
  isHeadless: boolean;
}

/** What the policies are built from, kept for mode switches and reloads */
interface PermissionSources {
  flags: { allow?: string[]; ask?: string[]; exclude?: string[] };
  agentFile?: AgentFileServiceState;
  mcp?: MCPServiceState;
}

/**
 * Service for managing tool permissions with a single source of truth
 */
export class ToolPermissionService
  extends BaseService<ToolPermissionServiceState>
  implements ServiceWithDependencies
{
  private sources: PermissionSources = { flags: {} };

  constructor() {
    super("ToolPermissionService", {
      permissions: { policies: [] },
      currentMode: "normal",
      isHeadless: false,
    });
  }

  /**
   * Override setState to notify the ServiceContainer
   * This ensures reactive UI components get updated when mode changes
   */
  protected override setState(
    newState: Partial<ToolPermissionServiceState>,
  ): void {
    super.setState(newState);
    serviceContainer.set(SERVICE_NAMES.TOOL_PERMISSIONS, this.currentState);
  }

  /**
   * Declare dependencies on other services
   */
  getDependencies(): string[] {
    return [SERVICE_NAMES.AGENT_FILE, SERVICE_NAMES.MCP];
  }

  /**
   * Generate agent-file-specific policies if an agent file is active
   */
  generateAgentFilePolicies(
    agentFileServiceState?: AgentFileServiceState,
    mcpServiceState?: MCPServiceState,
  ): ToolPermissionPolicy[] {
    // With --agent, all available tools are allowed if not specified
    const parsedTools = agentFileServiceState?.parsedTools;
    if (!parsedTools) {
      return [
        {
          tool: "*",
          permission: "allow",
        },
      ];
    }

    const policies: ToolPermissionPolicy[] = [];
    const servers = Array.from(mcpServiceState?.connections?.values() ?? []);
    for (const mcpServer of parsedTools.mcpServers) {
      const server = servers?.find(
        (s) => s.config?.sourceSlug && s.config.sourceSlug === mcpServer,
      );
      if (!server) {
        logger.warn("No connected MCP server found ");
        continue;
      }

      const specificTools = parsedTools.tools.filter(
        (t) => t.mcpServer && t.toolName && t.mcpServer === mcpServer,
      );

      // In the `tools` key of an agent is comma separated strings like
      // mcp/server, mcp/server2:tool_name, Bash
      // - this would give the agent access to ALL tools from mcp/server, ONLY tool_name from mcp/server2, and Bash, and no other tools
      // mcp/server
      // - this would give the agent access to ALL tools from mcp/server, and no built-ins
      // built_in, mcp/server
      // - "built_in" keyword can be used to include all built ins
      // Blank = all built-in tools

      // Handle MCP first
      // If ANY mcp tools are specifically called out, only allow those ones for that mcp server
      // Otherwise the blanket allow will cover all MCP tools
      if (specificTools.length) {
        const specificSet = new Set(specificTools.map((t) => t.toolName));
        const notMentioned = server.tools.filter(
          (t) => !specificSet.has(t.name),
        );
        const allowed: ToolPermissionPolicy[] = specificTools.map((t) => ({
          tool: t.toolName!,
          permission: "allow",
        }));
        policies.push(...allowed);
        const disallowed: ToolPermissionPolicy[] = notMentioned.map((t) => ({
          tool: t.name,
          permission: "exclude",
        }));
        policies.push(...disallowed);
      }
    }

    // If mcp servers or specific built-in tools are specified
    // then we only inclue listed built-in tools and exclude all others
    const hasMcp = !!parsedTools.mcpServers?.length;
    const specificBuiltIns = parsedTools.tools
      .filter((t) => !t.mcpServer)
      .map((t) => t.toolName!);
    if (specificBuiltIns.length || (hasMcp && !parsedTools.allBuiltIn)) {
      const allowed: ToolPermissionPolicy[] = specificBuiltIns.map((tool) => ({
        tool,
        permission: "allow",
      }));
      policies.push(...allowed);
      const specificBuiltInSet = new Set(specificBuiltIns);
      const notMentioned = BUILT_IN_TOOL_NAMES.filter(
        (name) => !specificBuiltInSet.has(name),
      );
      const disallowed: ToolPermissionPolicy[] = notMentioned.map((tool) => ({
        tool,
        permission: "exclude",
      }));
      policies.push(...disallowed);
    }

    // Allow all other tools
    policies.push({
      tool: "*",
      permission: "allow",
    });

    return policies;
  }

  /**
   * The policies for the current mode, built from the stored sources. Used on
   * init, on a mode switch and on a reload, so all three agree.
   *
   * - Plan mode (--readonly) uses only the plan-mode policies.
   * - An agent file's policies apply in normal and auto mode, after the flags.
   * - Auto mode without an agent file allows every tool.
   * - Normal mode layers flags, permissions.yaml and the defaults.
   */
  private buildPolicies(): ToolPermissionPolicy[] {
    const { currentMode, isHeadless } = this.currentState;
    const { flags, agentFile, mcp } = this.sources;
    if (currentMode === "plan") {
      return getPlanModePolicies(isHeadless);
    }
    if (agentFile?.agentFile) {
      return [
        ...commandLineFlagsToPolicies(flags),
        ...this.generateAgentFilePolicies(agentFile, mcp),
      ];
    }
    if (currentMode === "auto") {
      return [...AUTO_MODE_POLICIES];
    }
    return resolvePermissionPrecedence({
      commandLineFlags: flags,
      personalSettings: true,
      useDefaults: true,
      isHeadless,
    });
  }

  /**
   * Synchronously initialize with runtime overrides
   * Used for immediate availability of command-line permission overrides
   */
  initializeSync(
    runtimeOverrides?: InitializeToolServiceOverrides,
    agentFileServiceState?: AgentFileServiceState,
    mcpServiceState?: MCPServiceState,
  ): ToolPermissionServiceState {
    logger.debug("Synchronously initializing ToolPermissionService");

    this.sources = {
      flags: {
        allow: runtimeOverrides?.allow,
        ask: runtimeOverrides?.ask,
        exclude: runtimeOverrides?.exclude,
      },
      agentFile: agentFileServiceState,
      mcp: mcpServiceState,
    };
    this.setState({
      currentMode: runtimeOverrides?.mode ?? this.currentState.currentMode,
      isHeadless: runtimeOverrides?.isHeadless ?? this.currentState.isHeadless,
    });
    this.setState({ permissions: { policies: this.buildPolicies() } });

    (this as any).isInitialized = true;

    return this.getState();
  }

  /**
   * Initialize the tool permission service with runtime overrides (async version)
   */
  async doInitialize(
    runtimeOverrides?: InitializeToolServiceOverrides,
    agentFileServiceState?: AgentFileServiceState,
    mcpServiceState?: MCPServiceState,
  ): Promise<ToolPermissionServiceState> {
    await ensurePermissionsYamlExists();

    // Use the synchronous version after ensuring the file exists
    return this.initializeSync(
      runtimeOverrides,
      agentFileServiceState,
      mcpServiceState,
    );
  }

  /**
   * Get the compiled permissions
   */
  getPermissions(): ToolPermissions {
    return this.getState().permissions;
  }

  /**
   * Switch to a different permission mode
   */
  switchMode(newMode: PermissionMode): ToolPermissionServiceState {
    const currentMode = this.currentState.currentMode;
    logger.debug(`Switching from mode '${currentMode}' to '${newMode}'`);

    this.setState({ currentMode: newMode });
    this.emit("modeChanged", newMode, currentMode);
    this.setState({ permissions: { policies: this.buildPolicies() } });

    return this.getState();
  }

  /**
   * Get the current permission mode
   */
  getCurrentMode(): PermissionMode {
    return this.currentState.currentMode;
  }

  /**
   * Get the headless state
   */
  isHeadless(): boolean {
    return this.currentState.isHeadless;
  }

  /**
   * Reload permissions from configuration files
   * Useful after policy changes to update the in-memory permissions
   */
  async reloadPermissions(): Promise<void> {
    logger.debug("Reloading permissions from configuration files");
    this.setState({ permissions: { policies: this.buildPolicies() } });
  }

  /**
   * Override isReady to always return true since we initialize synchronously
   */
  override isReady(): boolean {
    return true;
  }
}
