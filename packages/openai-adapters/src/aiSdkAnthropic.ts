/**
 * Claude requests through the AI SDK (@ai-sdk/anthropic), built to send what
 * the Anthropic adapter (apis/Anthropic.ts) sends for the same body. Both
 * use the same rules: anthropicControlParams for thinking, effort and fast
 * mode, anthropicSamplingParams, the adapter's tool choice and max_tokens,
 * and the caching strategy's breakpoints.
 *
 * The AI SDK provider applies its own per-model rules on top and reports
 * each change as a warning. The parity tests (test/transportParity.vitest.ts)
 * fail on any warning, so these settings are the ones it accepts unchanged.
 */

import type { ChatCompletionCreateParams } from "openai/resources/index";

import {
  anthropicDefaultMaxTokens,
  type AnthropicReasoningControls,
} from "./apis/Anthropic.js";
import type { CachingStrategyName } from "./apis/AnthropicCachingStrategies.js";
import {
  anthropicControlParams,
  anthropicSamplingParams,
  anthropicThinkingOn,
  type AnthropicThinking,
} from "./apis/anthropicControls.js";
import { openAiToolChoiceToAnthropicToolChoice } from "./apis/AnthropicUtils.js";

/** The caching strategies the AI-SDK route applies; others stay on legacy */
export const AI_SDK_CACHING: readonly CachingStrategyName[] = [
  "none",
  "systemOnly",
  "systemAndTools",
];

/**
 * The beta header the adapter sends whenever caching is on. Caching no
 * longer needs it, but it is kept so both transports send the same header.
 */
const PROMPT_CACHING_BETA = "prompt-caching-2024-07-31";

const CACHE_CONTROL = { anthropic: { cacheControl: { type: "ephemeral" } } };

type Body = Omit<ChatCompletionCreateParams, "reasoning_effort"> &
  AnthropicReasoningControls;

type AiSdkToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "tool"; toolName: string };

export interface AnthropicCallSettings {
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  /** Undefined: no tools are sent (tool_choice "none", or none given) */
  toolNames?: Set<string>;
  toolChoice?: AiSdkToolChoice;
  providerOptions: { anthropic: Record<string, unknown> };
}

function sdkThinking(thinking: AnthropicThinking) {
  switch (thinking.type) {
    case "enabled":
      return { type: "enabled", budgetTokens: thinking.budget_tokens };
    case "adaptive":
      return {
        type: "adaptive",
        ...(thinking.display && { display: thinking.display }),
      };
    default:
      return { type: thinking.type };
  }
}

/** The tools the adapter sends: none for "none", else the allowed ones */
function toolNamesFor(body: Body): Set<string> | undefined {
  const functions = (body.tools ?? []).filter((t) => t.type === "function");
  if (body.tool_choice === "none" || functions.length === 0) {
    return undefined;
  }
  const choice = body.tool_choice;
  const allowed =
    typeof choice === "object" && choice?.type === "allowed_tools"
      ? new Set(choice.allowed_tools.tools.map((tool) => tool["name"]))
      : undefined;
  return new Set(
    functions
      .map((t) => (t as { function: { name: string } }).function.name)
      .filter((name) => !allowed || allowed.has(name)),
  );
}

/** Call settings for a Claude request; see the file comment */
export function anthropicCallSettings(
  body: Body,
  caching: CachingStrategyName,
): AnthropicCallSettings {
  const params = anthropicControlParams({
    model: body.model,
    effort: body.reasoning_effort,
    thinking: body.nextcli_thinking,
    showThinking: body.nextcli_show_thinking,
    budgetTokens: body.nextcli_thinking_budget,
    fast: body.nextcli_fast,
    maxTokens: body.max_tokens ?? anthropicDefaultMaxTokens(body.model),
  });
  const thinking = params.thinking;
  const sampling = anthropicSamplingParams(
    body.model,
    {
      temperature: body.temperature ?? undefined,
      topP: body.top_p ?? undefined,
      topK: body.top_k ?? undefined,
    },
    anthropicThinkingOn(thinking),
  );

  let choice = openAiToolChoiceToAnthropicToolChoice(
    body.tool_choice,
    body.model,
  );
  // Manual thinking only allows tool_choice auto or none
  if (
    thinking?.type === "enabled" &&
    (choice?.type === "any" || choice?.type === "tool")
  ) {
    choice = { type: "auto" };
  }
  const toolNames = toolNamesFor(body);

  const stop = (
    Array.isArray(body.stop) ? body.stop : body.stop ? [body.stop] : []
  ).filter((sequence) => sequence.trim() !== "");

  const betas = [
    ...(caching !== "none" ? [PROMPT_CACHING_BETA] : []),
    ...params.betas,
  ];

  return {
    // The provider adds a thinking budget to max_tokens itself; the adapter's
    // rule already made room for it
    maxOutputTokens:
      thinking?.type === "enabled"
        ? params.maxTokens - thinking.budget_tokens
        : params.maxTokens,
    temperature: sampling.temperature,
    topP: sampling.topP,
    topK: sampling.topK,
    stopSequences: stop.length > 0 ? stop : undefined,
    toolNames,
    toolChoice: !toolNames
      ? undefined
      : choice?.type === "any"
        ? "required"
        : choice?.type === "tool"
          ? { type: "tool", toolName: choice.name }
          : choice?.type === "auto"
            ? "auto"
            : undefined,
    providerOptions: {
      anthropic: {
        ...(thinking && { thinking: sdkThinking(thinking) }),
        ...(params.outputConfig && { effort: params.outputConfig.effort }),
        ...(params.speed && { speed: params.speed }),
        ...(betas.length > 0 && { anthropicBeta: betas }),
        // The adapter doesn't ask for eager tool input streaming
        toolStreaming: false,
      },
    },
  };
}

type Part = { type: string; providerOptions?: any; [key: string]: unknown };
type Message = { role: string; content: string | Part[]; [key: string]: any };

/** Reasoning Claude can verify: signed thinking, or redacted thinking */
function isVerifiable(part: Part): boolean {
  const anthropic = part.providerOptions?.anthropic;
  return (
    part.type !== "reasoning" ||
    !!anthropic?.signature ||
    !!anthropic?.redactedData
  );
}

/**
 * Puts a breakpoint on the last text part of each of the last two user
 * turns. A user turn is the run of user and tool messages Claude gets as
 * one user message; a turn of tool results alone has no text and gets none
 * (addCacheControlToLastTwoUserMessages in AnthropicUtils).
 */
function cacheLastTwoUserTurns(messages: Message[]): void {
  let turns = 0;
  let index = messages.length - 1;
  while (index >= 0 && turns < 2) {
    if (messages[index].role === "assistant") {
      index--;
      continue;
    }
    // One user turn: the user and tool messages back to the last assistant
    let marked = false;
    for (; index >= 0 && messages[index].role !== "assistant"; index--) {
      const message = messages[index];
      if (marked || message.role !== "user") continue;
      if (typeof message.content === "string") {
        if (!message.content) continue;
        message.content = [
          {
            type: "text",
            text: message.content,
            providerOptions: CACHE_CONTROL,
          },
        ];
        marked = true;
        continue;
      }
      for (let part = message.content.length - 1; part >= 0; part--) {
        if (message.content[part].type === "text") {
          message.content[part] = {
            ...message.content[part],
            providerOptions: CACHE_CONTROL,
          };
          marked = true;
          break;
        }
      }
    }
    turns++;
  }
}

/**
 * The prompt the adapter sends: unverifiable reasoning left out of the
 * history (Claude rejects it), and the caching strategy's breakpoints on the
 * system prompt, the last tool and the last two user turns.
 */
export function anthropicPrompt(
  prompt: {
    instructions?: string;
    messages: Message[];
    tools?: Record<string, Record<string, unknown>>;
  },
  caching: CachingStrategyName,
) {
  const messages: Message[] = [];
  for (const message of prompt.messages) {
    if (message.role !== "assistant" || typeof message.content === "string") {
      messages.push({ ...message });
      continue;
    }
    const content = message.content.filter(isVerifiable);
    // The adapter leaves out a message that has nothing left
    if (content.length > 0) {
      messages.push({ ...message, content });
    }
  }

  let tools = prompt.tools;
  if (caching === "none") {
    return { instructions: prompt.instructions, messages, tools };
  }
  if (caching === "systemAndTools" && tools) {
    const names = Object.keys(tools);
    const last = names[names.length - 1];
    tools = {
      ...tools,
      [last]: { ...tools[last], providerOptions: CACHE_CONTROL },
    };
  }
  cacheLastTwoUserTurns(messages);
  return {
    instructions: prompt.instructions
      ? {
          role: "system" as const,
          content: prompt.instructions,
          providerOptions: CACHE_CONTROL,
        }
      : undefined,
    messages,
    tools,
  };
}
