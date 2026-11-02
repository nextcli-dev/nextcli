import type { ModelConfig } from "@nextcli/config-yaml";
import { buildModelControlFields } from "@nextcli/openai-adapters";
import type { ToolStatus } from "core/index.js";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources.mjs";

import { ToolCallPreview } from "../tools/types.js";
import {
  getModelControlsFor,
  getModelSettings,
  modelIdentity,
} from "../util/modelSettings.js";

export interface StreamCallbacks {
  onContent?: (content: string) => void;
  onContentComplete?: (content: string) => void;
  onToolStart?: (toolName: string, toolArgs?: any) => void;
  onToolResult?: (result: string, toolName: string, status: ToolStatus) => void;
  onToolError?: (error: string, toolName?: string) => void;
  onToolPermissionRequest?: (
    toolName: string,
    toolArgs: any,
    requestId: string,
    preview?: ToolCallPreview[],
  ) => void;
  onSystemMessage?: (message: string) => void;
}

/**
 * Request options for a model: its configured completion options, plus the
 * reasoning, fast mode and thinking display chosen in the model menu, in the
 * format of the adapter the request goes through.
 */
export function getCompletionOptions(
  model: ModelConfig,
): Partial<ChatCompletionCreateParamsStreaming> {
  const opts = model.defaultCompletionOptions;
  const isAnthropic = getModelControlsFor(model).format === "anthropic";
  return {
    ...(opts && {
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      frequency_penalty: opts.frequencyPenalty,
      presence_penalty: opts.presencePenalty,
      top_p: opts.topP,
    }),
    // Not OpenAI fields: only the Anthropic adapter reads these
    ...(isAnthropic && opts?.topK !== undefined && { top_k: opts.topK }),
    ...(isAnthropic &&
      opts?.reasoningBudgetTokens !== undefined && {
        nextcli_thinking_budget: opts.reasoningBudgetTokens,
      }),
    ...buildModelControlFields(modelIdentity(model), getModelSettings(model)),
  } as Partial<ChatCompletionCreateParamsStreaming>;
}
