import { logger } from "./logger.js";

interface AiSdkWarningLog {
  warnings: unknown[];
  provider?: string;
  model?: string;
}

type AiSdkGlobal = {
  AI_SDK_LOG_WARNINGS?: ((log: AiSdkWarningLog) => void) | false;
};

/**
 * The AI SDK reports the settings a provider dropped or changed (a sampling
 * parameter the model rejects, a thinking mode it replaced) through
 * process.emitWarning by default, which writes into the terminal UI. The CLI
 * owns its process, so it sends them to the debug log instead, through the
 * SDK's documented global hook. A hook that is already set is kept.
 */
export function routeAiSdkWarningsToLog(): void {
  const scope = globalThis as AiSdkGlobal;
  if (scope.AI_SDK_LOG_WARNINGS !== undefined) {
    return;
  }
  scope.AI_SDK_LOG_WARNINGS = ({ warnings, provider, model }) => {
    for (const warning of warnings) {
      logger.debug("AI SDK warning", { provider, model, warning });
    }
  };
}
