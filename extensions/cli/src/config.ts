import {
  Configuration,
  DefaultApi,
} from "@continuedev/sdk/dist/api/dist/index.js";
import { AssistantUnrolled, ModelConfig } from "@nextcli/config-yaml";
import {
  AiSdkApi,
  BaseLlmApi,
  constructLlmApi,
  LLMConfig,
} from "@nextcli/openai-adapters";

import { AuthConfig } from "./auth/workos.js";
import { env } from "./env.js";
import { logger } from "./util/logger.js";
import { getUniqueId } from "./util/uniqueId.js";
import { getVersion } from "./version.js";

/**
 * Creates user-agent header value for CLI requests
 */
function getUserAgent(): string {
  const version = getVersion();
  return `Continue-CLI/${version}`;
}

/**
 * Merges user-agent header into request options
 */
function _mergeUserAgentIntoRequestOptions(
  requestOptions: ModelConfig["requestOptions"],
): ModelConfig["requestOptions"] {
  return {
    ...requestOptions,
    headers: {
      ...requestOptions?.headers,
      "user-agent": getUserAgent(),
      "x-continue-unique-id": getUniqueId(),
    },
  };
}

/**
 * OpenRouter lists cn as NextCLI (shared attribution headers); mark it as a
 * CLI agent rather than the IDE extension. The model's own headers win.
 */
export function withCliAttribution(
  model: ModelConfig,
): ModelConfig["requestOptions"] {
  if (model.provider !== "openrouter") {
    return model.requestOptions;
  }
  return {
    ...model.requestOptions,
    headers: {
      "X-OpenRouter-Categories": "cli-agent",
      ...model.requestOptions?.headers,
    },
  };
}

/**
 * Creates an LLM API instance from a ModelConfig and auth configuration
 */
export function createLlmApi(
  model: ModelConfig,
  _authConfig: AuthConfig,
): BaseLlmApi | null {
  const config: LLMConfig = {
    provider: model.provider as any,
    model: model.model,
    apiKey: model.apiKey,
    apiBase: model.apiBase,
    requestOptions: withCliAttribution(model),
    env: model.env,
    transport: model.transport,
  };

  const api = constructLlmApi(config) ?? null;
  if (api instanceof AiSdkApi) {
    // The AI SDK was chosen; say whether this model's chat uses it
    logger.debug("Chat transport", {
      model: model.model,
      transport: api.routeFor(model.model)
        ? "ai-sdk"
        : `${model.provider}'s own adapter (no AI-SDK route for this model)`,
    });
  }
  return api;
}

export function getLlmApi(
  assistant: AssistantUnrolled,
  authConfig: AuthConfig,
): [BaseLlmApi, ModelConfig] {
  if (!assistant.models || assistant.models.length === 0) {
    throw new Error("No models found in the configured assistant");
  }

  const model = assistant.models?.find(
    (model) =>
      model?.roles?.includes("chat") || (model && model.roles === undefined),
  );

  if (!model) {
    throw new Error(
      "No models with the chat role found in the configured assistant",
    );
  }

  const llmApi = createLlmApi(model, authConfig);

  if (!llmApi) {
    throw new Error(
      "Failed to initialize LLM. Please check your configuration.",
    );
  }

  return [llmApi, model];
}

/**
 * Hub client. There is no default host: local config still needs a client
 * object, and callers that talk to a hub must check `env.apiBase` first.
 */
export function getApiClient(
  accessToken: string | undefined | null,
): DefaultApi {
  return new DefaultApi(
    new Configuration({
      basePath: env.apiBase ? env.apiBase.replace(/\/$/, "") : "",
      accessToken: accessToken ?? undefined,
    }),
  );
}
