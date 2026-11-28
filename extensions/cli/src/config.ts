import { randomUUID } from "node:crypto";

import {
  Configuration,
  DefaultApi,
} from "@continuedev/sdk/dist/api/dist/index.js";
import { AssistantUnrolled, ModelConfig } from "@nextcli/config-yaml";
import {
  BaseLlmApi,
  constructLlmApi,
  LLMConfig,
} from "@nextcli/openai-adapters";

import { AuthConfig } from "./auth/workos.js";
import { env } from "./env.js";
import { traceModelRequests } from "./trace/trace.js";
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

/** The vendors a `provider: "ai-sdk"` model named, and their providers */
const AI_SDK_VENDORS: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "gemini",
  xai: "xAI",
  deepseek: "deepseek",
  openrouter: "openrouter",
  clawrouter: "clawrouter",
};

/**
 * `provider: "ai-sdk"` named its vendor in the model (`openai/gpt-4o`). It
 * went with the AI-SDK transport; the error names the config that replaces
 * it.
 */
function removedAiSdkProvider(model: string): Error {
  const [vendor, ...rest] = model.split("/");
  const provider = AI_SDK_VENDORS[vendor];
  const replacement =
    provider && rest.length > 0
      ? `provider "${provider}" with model "${rest.join("/")}"`
      : "the model vendor's own provider";
  return new Error(`provider "ai-sdk" was removed; use ${replacement}`);
}

// One per process: a run's requests share it, and parallel runs (CI checks
// with the same system prompt) don't crowd one cache
const PROMPT_CACHE_KEY = randomUUID();

/**
 * Creates an LLM API instance from a ModelConfig and auth configuration
 */
export function createLlmApi(
  model: ModelConfig,
  _authConfig: AuthConfig,
): BaseLlmApi | null {
  if (model.provider === "ai-sdk") {
    throw removedAiSdkProvider(model.model);
  }
  const config: LLMConfig = {
    provider: model.provider as any,
    apiKey: model.apiKey,
    apiBase: model.apiBase,
    requestOptions: withCliAttribution(model),
    env: model.env,
    // Prompt caching (Claude, Qwen) is on unless the model turns it off,
    // for example for a Vertex AI project that rejects cache_control
    ...(model.defaultCompletionOptions?.promptCaching === false && {
      cachingStrategy: "none",
    }),
    promptCacheKey: PROMPT_CACHE_KEY,
  };

  traceModelRequests(model);
  return constructLlmApi(config) ?? null;
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
