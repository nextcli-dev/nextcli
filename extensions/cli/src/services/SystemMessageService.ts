import { PermissionMode } from "../permissions/types.js";
import {
  constructSystemMessageParts,
  type SystemMessagePart,
} from "../systemMessage.js";
import { logger } from "../util/logger.js";

import { BaseService } from "./BaseService.js";
import { SERVICE_NAMES } from "./types.js";

export interface SystemMessageServiceState {
  additionalRules?: string[];
  format?: "json";
  headless?: boolean;
}

/**
 * Service for managing dynamic system message construction
 * Provides fresh system messages that reflect current mode and configuration
 */
export class SystemMessageService extends BaseService<SystemMessageServiceState> {
  /** The message returned by the last `getSystemMessage` call, with its parts. */
  lastBuilt?: { text: string; parts: SystemMessagePart[] };

  constructor() {
    super("SystemMessageService", {});
  }

  /**
   * Initialize the service
   */
  async doInitialize(args: {
    additionalRules?: string[];
    format?: "json";
    headless?: boolean;
  }): Promise<SystemMessageServiceState> {
    this.setState({
      additionalRules: args.additionalRules,
      format: args.format,
      headless: args.headless,
    });

    logger.debug("SystemMessageService initialized", {
      hasAdditionalRules: !!args.additionalRules?.length,
      format: args.format,
      headless: args.headless,
    });

    return this.currentState;
  }

  /**
   * Get a fresh system message with current mode and configuration
   */
  public async getSystemMessage(currentMode: PermissionMode): Promise<string> {
    const { additionalRules, format, headless } = this.currentState;

    const parts = await constructSystemMessageParts(
      currentMode,
      additionalRules,
      format,
      headless,
    );
    const systemMessage = parts.map((part) => part.text).join("");
    this.lastBuilt = { text: systemMessage, parts };

    logger.debug("Generated fresh system message", {
      mode: currentMode,
      messageLength: systemMessage.length,
    });

    return systemMessage;
  }

  getDependencies(): string[] {
    return [SERVICE_NAMES.TOOL_PERMISSIONS];
  }

  /**
   * Update configuration that affects system message
   */
  public updateConfig(config: Partial<SystemMessageServiceState>): void {
    this.setState({
      ...this.currentState,
      ...config,
    });

    logger.debug("SystemMessageService config updated", config);
  }
}
