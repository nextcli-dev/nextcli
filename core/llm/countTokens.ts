import {
  buildSnapshot,
  countToolTokens,
  memoizeCount,
  type ContextSegment,
  type ContextSnapshot,
} from "@nextcli/context";
import { Tiktoken, encodingForModel as _encodingForModel } from "js-tiktoken";

import {
  ChatMessage,
  CompiledMessagesResult,
  MessageContent,
  MessagePart,
  Tool,
} from "../index.js";
import { autodetectTemplateType } from "./autodetect.js";
import {
  addSpaceToAnyEmptyMessages,
  chatMessageIsEmpty,
  isUserOrToolMsg,
  messageHasToolCallId,
} from "./messages.js";

import { renderChatMessage } from "../util/messageContent.js";
import { AsyncEncoder, LlamaAsyncEncoder } from "./asyncEncoder.js";
import { DEFAULT_PRUNING_LENGTH } from "./constants.js";
import { getAdjustedTokenCountFromModel } from "./getAdjustedTokenCount.js";
import llamaTokenizer from "./llamaTokenizer.js";
interface Encoding {
  encode: Tiktoken["encode"];
  decode: Tiktoken["decode"];
}

class LlamaEncoding implements Encoding {
  encode(text: string): number[] {
    return llamaTokenizer.encode(text);
  }

  decode(tokens: number[]): string {
    return llamaTokenizer.decode(tokens);
  }
}

class NonWorkerAsyncEncoder implements AsyncEncoder {
  constructor(private readonly encoding: Encoding) {}

  async close(): Promise<void> {}

  async encode(text: string): Promise<number[]> {
    return this.encoding.encode(text);
  }

  async decode(tokens: number[]): Promise<string> {
    return this.encoding.decode(tokens);
  }
}

let gptEncoding: Encoding | null = null;
const llamaEncoding = new LlamaEncoding();
const llamaAsyncEncoder = new LlamaAsyncEncoder();

function asyncEncoderForModel(modelName: string): AsyncEncoder {
  // Temporary due to issues packaging the worker files
  if (process.env.IS_BINARY) {
    const encoding = encodingForModel(modelName);
    return new NonWorkerAsyncEncoder(encoding);
  }

  const modelType = autodetectTemplateType(modelName);
  if (!modelType || modelType === "none") {
    // Right now there is a problem packaging js-tiktoken in workers. Until then falling back
    // Cannot find package 'js-tiktoken' imported from /Users/nate/gh/nextcli-dev/nextcli/extensions/vscode/out/tiktokenWorkerPool.mjs
    // return gptAsyncEncoder;
    return llamaAsyncEncoder;
  }
  return llamaAsyncEncoder;
}

function encodingForModel(modelName: string): Encoding {
  const modelType = autodetectTemplateType(modelName);

  if (!modelType || modelType === "none") {
    if (!gptEncoding) {
      gptEncoding = _encodingForModel("gpt-4");
    }

    return gptEncoding;
  }

  return llamaEncoding;
}

function countImageTokens(content: MessagePart): number {
  if (content.type === "imageUrl") {
    return 1024;
  }
  throw new Error("Non-image content type");
}

async function countTokensAsync(
  content: MessageContent,
  // defaults to llama2 because the tokenizer tends to produce more tokens
  modelName = "llama2",
): Promise<number> {
  const encoding = asyncEncoderForModel(modelName);
  if (Array.isArray(content)) {
    const promises = content.map(async (part) => {
      if (part.type === "imageUrl") {
        return countImageTokens(part);
      }
      return (await encoding.encode(part.text ?? "")).length;
    });
    return (await Promise.all(promises)).reduce((sum, val) => sum + val, 0);
  }
  return (await encoding.encode(content ?? "")).length;
}

const countGptText = memoizeCount((text: string) => {
  if (!gptEncoding) {
    gptEncoding = _encodingForModel("gpt-4");
  }
  return gptEncoding.encode(text, "all", []).length;
});

const countLlamaText = memoizeCount(
  (text: string) => llamaEncoding.encode(text).length,
);

function countEncoded(text: string, modelName: string): number {
  const modelType = autodetectTemplateType(modelName);
  if (!modelType || modelType === "none") {
    return countGptText(text);
  }
  return countLlamaText(text);
}

function countTokens(
  content: MessageContent,
  // defaults to llama2 because the tokenizer tends to produce more tokens
  modelName = "llama2",
): number {
  let baseTokens = 0;
  if (Array.isArray(content)) {
    baseTokens = content.reduce((acc, part) => {
      return (
        acc +
        (part.type === "text"
          ? countEncoded(part.text ?? "", modelName)
          : countImageTokens(part))
      );
    }, 0);
  } else {
    baseTokens = countEncoded(content ?? "", modelName);
  }
  return getAdjustedTokenCountFromModel(baseTokens, modelName);
}

// https://community.openai.com/t/how-to-calculate-the-tokens-when-using-function-call/266573/10
function countToolsTokens(tools: Tool[], modelName: string): number {
  return countToolTokens(tools, (text) => countTokens(text, modelName)).total;
}

function countChatMessageTokens(
  modelName: string,
  chatMessage: ChatMessage,
): number {
  // Doing simpler, safer version of what is here:
  // https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb
  // every message follows <|im_start|>{role/name}\n{content}<|end|>\n
  const BASE_TOKENS = 4;
  const TOOL_CALL_EXTRA_TOKENS = 10;
  const TOOL_OUTPUT_EXTRA_TOKENS = 10;
  let tokens = BASE_TOKENS;

  if (chatMessage.content) {
    tokens += countTokens(chatMessage.content, modelName);
  }

  if ("toolCalls" in chatMessage && chatMessage.toolCalls) {
    for (const call of chatMessage.toolCalls) {
      tokens += TOOL_CALL_EXTRA_TOKENS;
      tokens += countTokens(JSON.stringify(call), modelName); // TODO hone this
    }
  }

  if (chatMessage.role === "thinking") {
    if (chatMessage.redactedThinking) {
      tokens += countTokens(chatMessage.redactedThinking, modelName);
    }
    if (chatMessage.signature) {
      tokens += countTokens(chatMessage.signature, modelName);
    }
  }

  if (chatMessage.role === "tool") {
    tokens += TOOL_OUTPUT_EXTRA_TOKENS; // safety
    if (chatMessage.toolCallId) {
      tokens += countTokens(chatMessage.toolCallId, modelName);
    }
  }
  return tokens;
}

/**
 * Extracts and validates the tool call sequence from the end of a message array.
 * Tool sequences consist of: [assistant_with_tool_calls, tool_response_1, tool_response_2, ...]
 * or just a single user message.
 *
 * @param messages - Array of chat messages (will be modified by popping messages)
 * @returns Array of messages that form the tool sequence
 */
function extractToolSequence(messages: ChatMessage[]): ChatMessage[] {
  const lastMsg = messages.pop();
  if (!lastMsg) {
    throw new Error("Error parsing chat history: no user/tool message found");
  }

  const toolSequence: ChatMessage[] = [];

  if (lastMsg.role === "tool") {
    toolSequence.push(lastMsg);

    // Collect all consecutive tool messages from the end
    while (
      messages.length > 0 &&
      messages[messages.length - 1].role === "tool"
    ) {
      toolSequence.unshift(messages.pop()!);
    }

    // Get the assistant message with tool calls
    const assistantMsg = messages.pop();
    if (assistantMsg) {
      toolSequence.unshift(assistantMsg);

      // Validate that all tool messages have matching tool call IDs
      for (const toolMsg of toolSequence.slice(1)) {
        // Skip assistant message
        if (
          toolMsg.role === "tool" &&
          !messageHasToolCallId(assistantMsg, toolMsg.toolCallId)
        ) {
          throw new Error(
            `Error parsing chat history: no tool call found to match tool output for id "${toolMsg.toolCallId}"`,
          );
        }
      }
    }
  } else if (lastMsg.role === "assistant" || lastMsg.role === "thinking") {
    toolSequence.push(lastMsg);
    while (
      messages.length > 0 &&
      (messages[messages.length - 1].role === "thinking" ||
        messages[messages.length - 1].role === "assistant")
    ) {
      toolSequence.unshift(messages.pop()!);
    }
  } else {
    // Single user message
    toolSequence.push(lastMsg);
  }

  return toolSequence;
}

function pruneLinesFromTop(
  prompt: string,
  maxTokens: number,
  modelName: string,
): string {
  const lines = prompt.split("\n");
  // Preprocess tokens for all lines and cache them.
  const lineTokens = lines.map((line) => countTokens(line, modelName));
  let totalTokens = lineTokens.reduce((sum, tokens) => sum + tokens, 0);
  let start = 0;
  let currentLines = lines.length;

  // Calculate initial token count including newlines
  totalTokens += Math.max(0, currentLines - 1); // Add tokens for joining newlines

  // Using indexes instead of array modifications.
  // Remove lines from the top until the token count is within the limit.
  while (totalTokens > maxTokens && start < currentLines) {
    totalTokens -= lineTokens[start];
    // Decrement token count for the removed line and its preceding/joining newline (if not the last line)
    if (currentLines - start > 1) {
      totalTokens--;
    }
    start++;
  }

  return lines.slice(start).join("\n");
}

function pruneLinesFromBottom(
  prompt: string,
  maxTokens: number,
  modelName: string,
): string {
  const lines = prompt.split("\n");
  const lineTokens = lines.map((line) => countTokens(line, modelName));
  let totalTokens = lineTokens.reduce((sum, tokens) => sum + tokens, 0);
  let end = lines.length;

  // Calculate initial token count including newlines
  totalTokens += Math.max(0, end - 1); // Add tokens for joining newlines

  // Reverse traversal to avoid array modification
  // Remove lines from the bottom until the token count is within the limit.
  while (totalTokens > maxTokens && end > 0) {
    end--;
    totalTokens -= lineTokens[end];
    // Decrement token count for the removed line and its following/joining newline (if not the first line)
    if (end > 0) {
      totalTokens--;
    }
  }

  return lines.slice(0, end).join("\n");
}

function pruneStringFromBottom(
  modelName: string,
  maxTokens: number,
  prompt: string,
): string {
  const encoding = encodingForModel(modelName);

  const tokens = encoding.encode(prompt, "all", []);
  if (tokens.length <= maxTokens) {
    return prompt;
  }

  return encoding.decode(tokens.slice(0, maxTokens));
}

function pruneStringFromTop(
  modelName: string,
  maxTokens: number,
  prompt: string,
): string {
  const encoding = encodingForModel(modelName);

  const tokens = encoding.encode(prompt, "all", []);
  if (tokens.length <= maxTokens) {
    return prompt;
  }

  return encoding.decode(tokens.slice(tokens.length - maxTokens));
}

const MAX_TOKEN_SAFETY_BUFFER = 1000;
const TOKEN_SAFETY_PROPORTION = 0.02;
export function getTokenCountingBufferSafety(contextLength: number) {
  return Math.min(
    MAX_TOKEN_SAFETY_BUFFER,
    contextLength * TOKEN_SAFETY_PROPORTION,
  );
}

const MIN_RESPONSE_TOKENS = 1000;

function pruneRawPromptFromTop(
  modelName: string,
  contextLength: number,
  prompt: string,
  tokensForCompletion: number,
): string {
  const maxTokens =
    contextLength -
    tokensForCompletion -
    getTokenCountingBufferSafety(contextLength);
  return pruneStringFromTop(modelName, maxTokens, prompt);
}

/**
 * Reconciles chat messages with available context length by intelligently pruning older messages
 * while preserving critical conversation elements.
 *
 * Core Guidelines:
 * - Always preserve the last user/tool message sequence (including any associated assistant message with tool calls)
 * - Always preserve the system message and tools
 * - Never allow orphaned tool responses without their corresponding tool calls
 * - Remove older messages first when pruning is necessary
 * - Maintain conversation coherence by flattening adjacent similar messages
 *
 * Process:
 * 1. Handle image content conversion for models that don't support images
 * 2. Extract and preserve system message
 * 3. Filter out empty messages and trailing non-user/tool messages
 * 4. Extract the complete tool sequence from the end (user message or assistant + tool responses)
 * 5. Calculate token requirements for non-negotiable elements (system, tools, last sequence)
 * 6. Prune older messages until within available token budget
 * 7. Reassemble with proper ordering and flatten adjacent similar messages
 *
 * @param params - Configuration object containing:
 *   - modelName: LLM model name for token counting
 *   - msgs: Array of chat messages to process
 *   - contextLength: Maximum context length supported by the model
 *   - maxTokens: Maximum tokens to reserve for the response
 *   - supportsImages: Whether the model supports image content
 *   - tools: Optional array of available tools
 * @returns Processed array of chat messages that fit within context constraints
 * @throws Error if non-negotiable elements exceed available context
 */
function compileSnapshot(input: {
  modelName: string;
  systemMsg: ChatMessage | undefined;
  systemMsgTokens: number;
  systemParts?: { label: string; chars: number }[];
  tools?: Tool[];
  perTool: number[];
  toolTokens: number;
  kept: { message: ChatMessage; tokens: number }[];
  toolSequence: ChatMessage[];
  historyTokens: number;
  knownContextLength: number | undefined;
  contextLength: number;
  countingSafetyBuffer: number;
  outputReserve: number;
  prunedMessages: number;
  prunedTokens: number;
  didPrune: boolean;
}): ContextSnapshot {
  const segments: ContextSegment[] = [];
  if (input.systemMsgTokens > 0) {
    const text =
      input.systemMsg && typeof input.systemMsg.content === "string"
        ? input.systemMsg.content
        : "";
    const children: ContextSegment[] = [];
    let cursor = 0;
    for (const [index, part] of (input.systemParts ?? []).entries()) {
      const slice = text.slice(cursor, cursor + part.chars);
      children.push({
        id: `system-${index}`,
        label: part.label,
        tokens: countTokens(slice, input.modelName),
        source: "estimated",
      });
      cursor += part.chars;
    }
    segments.push({
      id: "system",
      label: "System",
      tokens: input.systemMsgTokens,
      source: "estimated",
      ...(children.length > 0 ? { children } : {}),
    });
  }

  if (input.tools && input.tools.length > 0) {
    const groups = new Map<string, ContextSegment>();
    input.tools.forEach((tool, index) => {
      const groupName = tool.group || "Tools";
      const child: ContextSegment = {
        id: `tool-${tool.function.name}`,
        label: tool.function.name,
        tokens: input.perTool[index] ?? 0,
        source: "estimated",
      };
      const group = groups.get(groupName);
      if (group) {
        group.tokens += child.tokens;
        group.children?.push(child);
      } else {
        groups.set(groupName, {
          id: `tools-${groupName}`,
          label: groupName,
          tokens: child.tokens,
          source: "estimated",
          children: [child],
        });
      }
    });
    segments.push({
      id: "tools",
      label: "Tools",
      tokens: input.toolTokens,
      source: "estimated",
      children: [...groups.values()],
    });
  }

  const names = new Map<string, string>();
  const historyChildren = new Map<string, number>();
  const toolResults: { label: string; tokens: number }[] = [];
  const countMessage = (message: ChatMessage, tokens: number) => {
    if ("toolCalls" in message && message.toolCalls) {
      for (const call of message.toolCalls) {
        if (call.id && call.function?.name) {
          names.set(call.id, call.function.name);
        }
      }
    }
    if (message.role === "tool") {
      toolResults.push({
        label:
          ("toolCallId" in message && names.get(message.toolCallId ?? "")) ||
          "Tool result",
        tokens,
      });
      return;
    }
    historyChildren.set(
      message.role,
      (historyChildren.get(message.role) ?? 0) + tokens,
    );
  };
  for (const item of input.kept) {
    countMessage(item.message, item.tokens);
  }
  for (const message of input.toolSequence) {
    countMessage(message, countChatMessageTokens(input.modelName, message));
  }
  const roleLabel: Record<string, string> = {
    user: "User",
    assistant: "Assistant",
    thinking: "Thinking",
  };
  segments.push({
    id: "history",
    label: "History",
    tokens: input.historyTokens,
    source: "estimated",
    children: [...historyChildren.entries()].map(([role, tokens]) => ({
      id: `history-${role}`,
      label: roleLabel[role] ?? role,
      tokens,
      source: "estimated" as const,
    })),
  });

  const windowLabel =
    input.knownContextLength === undefined ? "default" : "model context length";
  return buildSnapshot({
    window: input.contextLength,
    threshold: {
      tokens:
        input.contextLength - input.countingSafetyBuffer - input.outputReserve,
      action: "pruning",
      steps: [
        { label: windowLabel, tokens: input.contextLength },
        { label: "safety buffer", tokens: -input.countingSafetyBuffer },
        { label: "output reserve", tokens: -input.outputReserve },
      ],
    },
    segments,
    toolResults,
    ...(input.didPrune
      ? {
          pruned: {
            messages: input.prunedMessages,
            tokens: input.prunedTokens,
          },
        }
      : {}),
  });
}

function compileChatMessages({
  modelName,
  msgs,
  knownContextLength,
  maxTokens,
  supportsImages,
  tools,
  systemParts,
  shortensAnswerToFit = false,
}: {
  modelName: string;
  msgs: ChatMessage[];
  knownContextLength: number | undefined;
  maxTokens: number;
  supportsImages: boolean;
  tools?: Tool[];
  systemParts?: { label: string; chars: number }[];
  shortensAnswerToFit?: boolean;
}): CompiledMessagesResult {
  let didPrune = false;

  let msgsCopy: ChatMessage[] = msgs.map((m) => ({ ...m }));

  // If images not supported, convert MessagePart[] to string
  if (!supportsImages) {
    for (const msg of msgsCopy) {
      if ("content" in msg && Array.isArray(msg.content)) {
        const content = renderChatMessage(msg);
        msg.content = content;
      }
    }
  }

  // Extract system message
  const systemMsg = msgsCopy.find((msg) => msg.role === "system");
  msgsCopy = msgsCopy.filter((msg) => msg.role !== "system");

  // Remove any empty messages or non-user/tool trailing messages
  msgsCopy = msgsCopy.filter((msg) => !chatMessageIsEmpty(msg));

  msgsCopy = addSpaceToAnyEmptyMessages(msgsCopy);

  // Extract the tool sequence from the end of the message array
  const toolSequence = extractToolSequence(msgsCopy);

  // Count tokens for all messages in the tool sequence
  let lastMessagesTokens = 0;
  for (const msg of toolSequence) {
    lastMessagesTokens += countChatMessageTokens(modelName, msg);
  }

  // System message
  let systemMsgTokens = 0;
  if (systemMsg) {
    systemMsgTokens = countChatMessageTokens(modelName, systemMsg);
  }

  // Tools
  let toolTokens = 0;
  let perTool: number[] = [];
  if (tools && tools.length > 0) {
    const counted = countToolTokens(tools, (text) =>
      countTokens(text, modelName),
    );
    toolTokens = counted.total;
    perTool = counted.perTool;
  }

  const contextLength = knownContextLength ?? DEFAULT_PRUNING_LENGTH;
  const countingSafetyBuffer = getTokenCountingBufferSafety(contextLength);
  const minOutputTokens = Math.min(MIN_RESPONSE_TOKENS, maxTokens);
  // Most servers reject input that leaves less than the max_tokens they are
  // sent. Up to a quarter of the window, the cap the constructor puts on
  // catalog output limits, so a max_tokens set near the window can't take
  // it; the request then sends only the max_tokens that fit (maxTokensThatFit)
  const outputReserve = shortensAnswerToFit
    ? minOutputTokens
    : Math.min(maxTokens, Math.floor(contextLength / 4));

  // Room left beside the non-negotiable messages
  const room =
    contextLength -
    countingSafetyBuffer -
    toolTokens -
    systemMsgTokens -
    lastMessagesTokens;

  // Make sure there's enough context for the non-excludable items
  if (knownContextLength !== undefined && room < minOutputTokens) {
    throw new Error(
      `Not enough context available to include the system message, last user message, and tools.
        There must be at least ${minOutputTokens} tokens remaining for output.
        Request had the following token counts:
        - contextLength: ${knownContextLength}
        - counting safety buffer: ${countingSafetyBuffer}
        - tools: ~${toolTokens}
        - system message: ~${systemMsgTokens}
        - max output tokens: ${maxTokens}`,
    );
  }

  // Older history makes room for the reserve. A newest turn that leaves less
  // than the reserve is still sent, as before, with no older history
  const inputTokensAvailable = room - outputReserve;

  // Now remove messages till we're under the limit
  let currentTotal = 0;
  let prunedMessages = 0;
  let prunedTokens = 0;
  const historyWithTokens = msgsCopy.map((message) => {
    const tokens = countChatMessageTokens(modelName, message);
    currentTotal += tokens;
    return {
      ...message,
      tokens,
    };
  });

  while (historyWithTokens.length > 0 && currentTotal > inputTokensAvailable) {
    const message = historyWithTokens.shift()!;
    currentTotal -= message.tokens;
    prunedMessages += 1;
    prunedTokens += message.tokens;
    didPrune = true;

    // At this point make sure no latent tool response without corresponding call
    while (historyWithTokens[0]?.role === "tool") {
      const message = historyWithTokens.shift()!;
      currentTotal -= message.tokens;
      prunedMessages += 1;
      prunedTokens += message.tokens;
    }
  }

  // Now reassemble
  const reassembled: ChatMessage[] = [];
  if (systemMsg) {
    reassembled.push(systemMsg);
  }
  reassembled.push(...historyWithTokens.map(({ tokens, ...rest }) => rest));
  reassembled.push(...toolSequence);

  const inputTokens =
    currentTotal + systemMsgTokens + toolTokens + lastMessagesTokens;
  const availableTokens = contextLength - countingSafetyBuffer - outputReserve;
  const contextPercentage = inputTokens / availableTokens;
  return {
    compiledChatMessages: reassembled,
    didPrune,
    contextPercentage,
    snapshot: compileSnapshot({
      modelName,
      systemMsg,
      systemMsgTokens,
      systemParts,
      tools,
      perTool,
      toolTokens,
      kept: historyWithTokens.map(({ tokens, ...rest }) => ({
        message: rest,
        tokens,
      })),
      toolSequence,
      historyTokens: currentTotal + lastMessagesTokens,
      knownContextLength,
      contextLength,
      countingSafetyBuffer,
      outputReserve,
      prunedMessages,
      prunedTokens,
      didPrune,
    }),
  };
}

async function cleanupAsyncEncoders(): Promise<void> {
  try {
    await llamaAsyncEncoder.close();
  } catch (e) {}
}

/**
 * The max_tokens a request can send to a server that rejects one whose input
 * plus max_tokens passes the window: the configured value, lowered to what
 * the window leaves after these messages and tools, but never below the
 * 1,000-token floor compileChatMessages keeps
 */
function maxTokensThatFit({
  modelName,
  messages,
  tools,
  contextLength,
  maxTokens,
}: {
  modelName: string;
  messages: ChatMessage[];
  tools?: Tool[];
  contextLength: number;
  maxTokens: number;
}): number {
  const inputTokens =
    messages.reduce(
      (sum, message) => sum + countChatMessageTokens(modelName, message),
      0,
    ) + (tools ? countToolsTokens(tools, modelName) : 0);
  const left =
    contextLength - getTokenCountingBufferSafety(contextLength) - inputTokens;
  return Math.min(
    maxTokens,
    Math.max(left, Math.min(MIN_RESPONSE_TOKENS, maxTokens)),
  );
}

export {
  cleanupAsyncEncoders,
  compileChatMessages,
  countTokens,
  countTokensAsync,
  extractToolSequence,
  maxTokensThatFit,
  pruneLinesFromBottom,
  pruneLinesFromTop,
  pruneRawPromptFromTop,
  pruneStringFromBottom,
  pruneStringFromTop,
};
