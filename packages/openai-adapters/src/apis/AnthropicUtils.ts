import {
  Base64ImageSource,
  ErrorResponse,
  MessageParam,
  Tool,
  ToolChoice,
} from "@anthropic-ai/sdk/resources";
import {
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from "openai/resources";

export function getAnthropicErrorMessage(response: ErrorResponse): string {
  switch (response.error.type) {
    case "api_error":
      return "An unexpected error has occurred internal to Anthropic's systems.";
    case "invalid_request_error":
      return "There was an issue with the format or content of your request.";
    case "authentication_error":
      return "There's an issue with your API key.";
    case "permission_error":
      return "Your API key does not have permission to use the specified resource.";
    case "not_found_error":
      return "The requested resource was not found.";
    case "rate_limit_error":
      return "Your account has hit a rate limit.";
    case "overloaded_error":
      return "Anthropic's API is temporarily overloaded. Please check their status page: https://status.anthropic.com/#past-incidents";
    case "timeout_error":
      return "Anthropic API timed out. Please check their status page: https://status.anthropic.com/#past-incidents";
    case "billing_error":
    default:
      return response.error.message;
  }
}

/**
 * Detects if the given API base URL is an Azure-hosted Anthropic endpoint.
 * Azure AI Foundry hosts Anthropic models but requires a different auth header.
 *
 * Supported Azure endpoint patterns:
 * - *.services.ai.azure.com (Azure AI Foundry)
 * - *.cognitiveservices.azure.com (Azure Cognitive Services)
 *
 * @param apiBase - The API base URL to check
 * @returns true if the endpoint is an Azure-hosted Anthropic endpoint
 */
export function isAzureAnthropicEndpoint(apiBase?: string): boolean {
  if (!apiBase) {
    return false;
  }

  try {
    const url = new URL(apiBase);
    const hostname = url.hostname.toLowerCase();
    return (
      hostname.endsWith(".services.ai.azure.com") ||
      hostname.endsWith(".cognitiveservices.azure.com")
    );
  } catch {
    // Invalid URL - fall back to false
    return false;
  }
}

export function getAnthropicHeaders(
  apiKey: string,
  enableCaching: boolean,
  apiBase?: string,
): Record<string, string> {
  const isAzure = isAzureAnthropicEndpoint(apiBase);

  // Warn if Azure endpoint is used with Anthropic-style key
  if (isAzure && apiKey.startsWith("sk-ant-")) {
    console.warn(
      "[Continue] Azure endpoint detected but API key appears to be a standard Anthropic key (sk-ant-*). " +
        "Azure endpoints require Azure API keys from your AI Foundry resource.",
    );
  }

  const authHeaderName =
    isAzure && apiBase?.toLowerCase().includes("cognitiveservices.azure.com")
      ? "api-key"
      : "x-api-key";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "anthropic-version": "2023-06-01",
    [authHeaderName]: apiKey,
  };

  if (enableCaching) {
    headers["anthropic-beta"] = "prompt-caching-2024-07-31";
  }
  return headers;
}

export function addCacheControlToLastTwoUserMessages(messages: MessageParam[]) {
  let userMessages = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      userMessages++;
      if (typeof msg.content === "string") {
        continue;
      }
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const part = msg.content[j];
        if (part.type === "text") {
          part.cache_control = { type: "ephemeral" };
          break;
        }
      }
      if (userMessages >= 2) {
        break;
      }
    }
  }
}

interface ClaudeModelVersion {
  family: "opus" | "sonnet" | "haiku" | "fable";
  major: number;
  minor: number;
}

/**
 * Parses Claude model ids in both naming schemes, including dated snapshots and
 * Bedrock/Vertex prefixes: claude-sonnet-5-5, claude-opus-4-5-20251101,
 * claude-3-5-sonnet-20241022, us.anthropic.claude-opus-4-7-v1:0.
 */
export function parseClaudeModelVersion(
  model: string | undefined,
): ClaudeModelVersion | undefined {
  if (!model) {
    return undefined;
  }
  const lower = model.toLowerCase();
  const familyFirst = lower.match(
    /claude-(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d{1,2})(?!\d))?/,
  );
  if (familyFirst) {
    return {
      family: familyFirst[1] as ClaudeModelVersion["family"],
      major: Number(familyFirst[2]),
      minor: Number(familyFirst[3] ?? 0),
    };
  }
  const versionFirst = lower.match(
    /claude-(\d+)(?:[-.](\d{1,2})(?!\d))?-(opus|sonnet|haiku)/,
  );
  if (versionFirst) {
    return {
      family: versionFirst[3] as ClaudeModelVersion["family"],
      major: Number(versionFirst[1]),
      minor: Number(versionFirst[2] ?? 0),
    };
  }
  return undefined;
}

function isAtLeast(
  version: ClaudeModelVersion,
  major: number,
  minor: number,
): boolean {
  return (
    version.major > major || (version.major === major && version.minor >= minor)
  );
}

/**
 * Claude 4.6 and newer take `thinking: { type: "adaptive" }`. From Opus 4.7 on,
 * `{ type: "enabled", budget_tokens }` is rejected, and models before 4.6 reject
 * "adaptive". Unknown model names keep the older "enabled" form.
 */
export function anthropicThinkingType(
  model: string | undefined,
): "adaptive" | "enabled" {
  const version = parseClaudeModelVersion(model);
  return version && isAtLeast(version, 4, 6) ? "adaptive" : "enabled";
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORT_ORDER: AnthropicEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Effort levels (`output_config.effort`) a Claude model accepts, lowest first.
 * Opus 4.5 takes low to high; Opus/Sonnet 4.6 add max; Opus 4.7, 4.8 and every
 * 5.x model also take xhigh. Older models and Haiku/Sonnet 4.5 have no effort
 * parameter (an empty list), so a thinking budget is used instead.
 */
export function anthropicEffortLevels(
  model: string | undefined,
): AnthropicEffort[] {
  const version = parseClaudeModelVersion(model);
  if (!version) {
    return [];
  }
  if (isAtLeast(version, 4, 7)) {
    return [...EFFORT_ORDER];
  }
  if (
    isAtLeast(version, 4, 6) &&
    (version.family === "opus" || version.family === "sonnet")
  ) {
    return ["low", "medium", "high", "max"];
  }
  if (version.family === "opus" && isAtLeast(version, 4, 5)) {
    return ["low", "medium", "high"];
  }
  return [];
}

/**
 * Maps a requested effort onto the levels the model accepts: the requested
 * level if supported, otherwise the nearest lower one. "minimal" (an OpenAI
 * level) maps to "low". Returns undefined when the model has no effort levels.
 */
export function clampAnthropicEffort(
  model: string | undefined,
  effort: string,
): AnthropicEffort | undefined {
  const levels = anthropicEffortLevels(model);
  if (levels.length === 0) {
    return undefined;
  }
  const requested = effort === "minimal" ? "low" : effort;
  const index = EFFORT_ORDER.indexOf(requested as AnthropicEffort);
  if (index === -1) {
    return undefined;
  }
  for (let i = index; i >= 0; i--) {
    if (levels.includes(EFFORT_ORDER[i])) {
      return EFFORT_ORDER[i];
    }
  }
  return levels[0];
}

/**
 * Fast mode (`speed: "fast"`): generally available on Opus 5.5, and in
 * research preview on Opus 5 and Opus 4.8, where it needs the
 * `fast-mode-2026-02-01` beta header. Other models reject it.
 */
export function anthropicFastMode(
  model: string | undefined,
): "available" | "beta" | undefined {
  const version = parseClaudeModelVersion(model);
  if (version?.family !== "opus") {
    return undefined;
  }
  if (version.major === 5 && version.minor === 5) {
    return "available";
  }
  if (
    (version.major === 5 && version.minor === 0) ||
    (version.major === 4 && version.minor === 8)
  ) {
    return "beta";
  }
  return undefined;
}

export const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01";

/**
 * Claude 5 models think by default and return the thinking text only when
 * `display: "summarized"` is requested. Earlier models think only when asked.
 */
export function anthropicThinksByDefault(model: string | undefined): boolean {
  const version = parseClaudeModelVersion(model);
  return !!version && version.major >= 5;
}

/** The `thinking` value that turns thinking off on a model */
export type AnthropicThinkingOffType = "disabled" | "between_tools";

/**
 * How thinking is turned off, per the Anthropic API (checked live against
 * /v1/models `capabilities.thinking.types` and /v1/messages, 2026-11-04):
 * - Opus 5.5 and Fable 5 / 5.1 can't turn it off at all (only `adaptive`).
 * - Sonnet 5.5 rejects `disabled` and uses `between_tools` instead: no
 *   thinking before answering, short updates between tool calls.
 * - Sonnet 5.5, Haiku 5.5 and Opus 5 accept off only at effort `high` or
 *   below ("effort 'xhigh' is not supported when thinking is disabled").
 * - Every other Claude model (and unknown names) uses `disabled`.
 * Returns undefined where off isn't possible for that model and effort.
 */
export function anthropicThinkingOffType(
  model: string | undefined,
  effort?: string,
): AnthropicThinkingOffType | undefined {
  const version = parseClaudeModelVersion(model);
  if (!version) {
    return "disabled";
  }
  const { family, major, minor } = version;
  const is = (f: typeof family, ma: number, mi: number) =>
    family === f && major === ma && minor === mi;
  if (is("opus", 5, 5) || (family === "fable" && major >= 5)) {
    return undefined;
  }
  const effortLimited =
    is("sonnet", 5, 5) || is("haiku", 5, 5) || is("opus", 5, 0);
  if (effortLimited && (effort === "xhigh" || effort === "max")) {
    return undefined;
  }
  return is("sonnet", 5, 5) ? "between_tools" : "disabled";
}

/** Whether the model can turn thinking off at some effort level */
export function anthropicCanDisableThinking(
  model: string | undefined,
): boolean {
  return anthropicThinkingOffType(model, "low") !== undefined;
}

/**
 * Claude 4.6 and newer reject a conversation that ends with an assistant
 * message ("does not support assistant message prefill"). Haiku 4.5 and older
 * models accept it. Unknown model names are assumed to accept it.
 */
export function anthropicSupportsPrefill(model: string | undefined): boolean {
  const version = parseClaudeModelVersion(model);
  return !version || !isAtLeast(version, 4, 6);
}

export interface AnthropicSamplingParams {
  temperature?: number;
  topP?: number;
  topK?: number;
}

/**
 * Claude Opus 4.7 and newer reject temperature, top_p and top_k. Older Claude
 * models reject temperature and top_p together, so top_p is dropped when both
 * are set. Non-Claude models (for example on Bedrock) are passed through.
 */
export function filterAnthropicSamplingParams(
  model: string | undefined,
  params: AnthropicSamplingParams,
): AnthropicSamplingParams {
  const version = parseClaudeModelVersion(model);
  if (!version) {
    return params;
  }
  if (isAtLeast(version, 4, 7)) {
    return {};
  }
  if (params.temperature !== undefined && params.topP !== undefined) {
    return { temperature: params.temperature, topK: params.topK };
  }
  return params;
}

/**
 * Sonnet/Opus 5.5 and Fable 5.1 reject tool_choice types "any" and "tool".
 * Haiku 5.5 and older models accept them. Assumed to hold for later versions.
 */
export function anthropicSupportsForcedToolChoice(
  model: string | undefined,
): boolean {
  const version = parseClaudeModelVersion(model);
  if (!version) {
    return true;
  }
  switch (version.family) {
    case "opus":
    case "sonnet":
      return !isAtLeast(version, 5, 5);
    case "fable":
      return !isAtLeast(version, 5, 1);
    case "haiku":
      return !isAtLeast(version, 6, 0);
  }
}

export function openAiToolChoiceToAnthropicToolChoice(
  toolChoice: ChatCompletionToolChoiceOption | undefined,
  model?: string,
): ToolChoice | undefined {
  if (!toolChoice) {
    return undefined;
  }
  const choice = openAiToolChoiceToAnthropicToolChoiceUnchecked(toolChoice);
  if (
    choice &&
    (choice.type === "any" || choice.type === "tool") &&
    !anthropicSupportsForcedToolChoice(model)
  ) {
    return { type: "auto" };
  }
  return choice;
}

function openAiToolChoiceToAnthropicToolChoiceUnchecked(
  toolChoice: ChatCompletionToolChoiceOption,
): ToolChoice | undefined {
  switch (toolChoice) {
    case "none":
      // "none" is handled by excluding tools
      return undefined;
    case "required":
      return {
        type: "any",
      };
    case "auto":
      return {
        type: "auto",
      };
    default:
      switch (toolChoice.type) {
        case "allowed_tools":
          // Filtering of tools is handled elsewhere
          return {
            type: toolChoice.allowed_tools.mode === "auto" ? "auto" : "any",
          };
        case "custom":
          return undefined; // TODO not supported yet
        case "function":
          return {
            type: "tool",
            name: toolChoice.function.name,
          };
      }
  }
}

export function openaiToolToAnthropicTool(tool: ChatCompletionTool): Tool {
  if (tool.type === "function" && "function" in tool) {
    return {
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters as Tool.InputSchema, // TODO unsafe cast, may be differences between openai tool schema and anthropic tool schema,
    };
  } else {
    throw new Error(`Unsupported tool type in Anthropic: ${tool.type}`);
  }
}

// Extract media type from data URL (ex. "data:image/png;base64,..." -> "image/png")
export function getAnthropicMediaTypeFromDataUrl(
  dataUrl: string,
): Base64ImageSource["media_type"] {
  const match = dataUrl.match(/^data:([^;]+);base64,/);
  if (match) {
    switch (match[1]) {
      case "image/png":
      case "image/gif":
      case "image/webp":
        return match[1];
    }
  }
  return "image/jpeg";
}
