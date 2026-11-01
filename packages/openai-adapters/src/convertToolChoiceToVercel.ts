/**
 * Converts OpenAI tool_choice format to Vercel AI SDK toolChoice format
 */

import type { ChatCompletionToolChoiceOption } from "openai/resources/index.js";

import { anthropicSupportsForcedToolChoice } from "./apis/AnthropicUtils.js";

/**
 * Converts OpenAI tool_choice to Vercel AI SDK toolChoice format
 *
 * OpenAI format:
 * - 'auto' | 'none' | 'required'
 * - { type: 'function', function: { name: string } }
 *
 * Vercel AI SDK format:
 * - 'auto' | 'none' | 'required'
 * - { type: 'tool', toolName: string }
 *
 * Anthropic models that reject forced tool use get "auto" instead of "required" or a named tool.
 */
export function convertToolChoiceToVercel(
  toolChoice: ChatCompletionToolChoiceOption | undefined,
  target?: { provider: string; model: string },
):
  | "auto"
  | "none"
  | "required"
  | { type: "tool"; toolName: string }
  | undefined {
  if (!toolChoice) {
    return undefined;
  }

  const forcedUnsupported =
    target?.provider === "anthropic" &&
    !anthropicSupportsForcedToolChoice(target.model);
  if (
    forcedUnsupported &&
    (toolChoice === "required" ||
      (typeof toolChoice !== "string" && toolChoice.type === "function"))
  ) {
    return "auto";
  }

  // String values pass through
  if (typeof toolChoice === "string") {
    return toolChoice as "auto" | "none" | "required";
  }

  // Convert object format
  if (toolChoice.type === "function") {
    return {
      type: "tool",
      toolName: toolChoice.function.name,
    };
  }

  // Unknown format - return undefined to let Vercel handle it
  return undefined;
}
