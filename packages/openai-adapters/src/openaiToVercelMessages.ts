/**
 * Converts OpenAI chat messages to AI SDK model messages.
 *
 * - System messages are returned separately: AI SDK 7 takes them as
 *   `instructions` and rejects system messages in `messages`.
 * - User images (`image_url`, a web URL or a data URL) become file parts.
 * - Assistant reasoning comes back as reasoning parts, from the fields the
 *   stream converter (vercelStreamConverter.ts) and the native adapters fill:
 *   `reasoning_details` items carry Claude's signatures and redacted thinking
 *   and OpenAI's encrypted reasoning; a plain `reasoning_content` or
 *   `reasoning` string (DeepSeek, Kimi, most gateways) becomes one reasoning
 *   part, which OpenAI-compatible providers send back as `reasoning_content`.
 *   The `reasoning_details` also go to OpenAI-compatible gateways as they
 *   are (OpenRouter needs them back for Claude's signatures), through
 *   `providerOptions.openaiCompatible`, which that provider copies into the
 *   message.
 * - Tool calls become tool-call parts, with Gemini's thought signature;
 *   tool messages become tool results.
 */

import type { ChatCompletionMessageParam } from "openai/resources/index.js";

export interface VercelCoreMessage {
  role: "user" | "assistant" | "tool";
  content: string | Array<any>;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface ConvertedMessages {
  /** The system messages' text, joined, for `instructions` */
  instructions?: string;
  messages: VercelCoreMessage[];
}

interface ReasoningDetail {
  type?: string;
  text?: string;
  summary?: string;
  signature?: string;
  data?: string;
  id?: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && part.type === "text"
        ? String(part.text ?? "")
        : "",
    )
    .join("");
}

/**
 * An image as a file part (AI SDK 7 deprecates the `image` part). Without a
 * known subtype the media type is the top-level `image`, and the provider
 * detects the subtype from the bytes.
 */
function imagePart(url: string): Record<string, unknown> {
  const dataUrl = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (dataUrl) {
    return {
      type: "file",
      data: dataUrl[3],
      mediaType: dataUrl[1] || "image",
    };
  }
  return { type: "file", data: new URL(url), mediaType: "image" };
}

function userContent(content: unknown): string | Array<any> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: any[] = [];
  for (const part of content) {
    if (part?.type === "text") {
      parts.push({ type: "text", text: part.text ?? "" });
    } else if (part?.type === "image_url" && part.image_url?.url) {
      parts.push(imagePart(part.image_url.url));
    }
  }
  return parts;
}

/**
 * Reasoning parts from `reasoning_details`. OpenAI items (they have an `id`)
 * are grouped by id: the summaries become the text and the encrypted content
 * goes in providerOptions. Claude items keep their order: signed text becomes
 * a thinking block, encrypted data a redacted one. Any other item with text
 * or a summary (OpenRouter's summaries carry no id) is plain reasoning text.
 */
function reasoningPartsFromDetails(details: ReasoningDetail[]): any[] {
  const parts: any[] = [];
  const openaiItems = new Map<string, { text: string; encrypted?: string }>();
  for (const detail of details) {
    if (!detail || typeof detail !== "object") continue;
    if (detail.id) {
      let item = openaiItems.get(detail.id);
      if (!item) {
        item = { text: "" };
        openaiItems.set(detail.id, item);
        parts.push({ openaiItemId: detail.id });
      }
      if (detail.type === "reasoning.encrypted" && detail.data) {
        item.encrypted = detail.data;
      } else {
        item.text += detail.summary ?? detail.text ?? "";
      }
    } else if (detail.type === "reasoning.encrypted" && detail.data) {
      parts.push({
        type: "reasoning",
        text: "",
        providerOptions: { anthropic: { redactedData: detail.data } },
      });
    } else if (detail.type === "reasoning.text") {
      parts.push({
        type: "reasoning",
        text: detail.text ?? "",
        ...(detail.signature && {
          providerOptions: { anthropic: { signature: detail.signature } },
        }),
      });
    } else {
      const text = detail.summary ?? detail.text;
      if (text) parts.push({ type: "reasoning", text });
    }
  }
  return parts.map((part) => {
    if (!part.openaiItemId) return part;
    const item = openaiItems.get(part.openaiItemId)!;
    return {
      type: "reasoning",
      text: item.text,
      providerOptions: {
        openai: {
          itemId: part.openaiItemId,
          ...(item.encrypted && { reasoningEncryptedContent: item.encrypted }),
        },
      },
    };
  });
}

/**
 * The message's reasoning parts. The plain text is added only when the
 * details have no readable text of their own (encrypted items alone), so a
 * signed Claude block is never followed by an unsigned copy of its text.
 */
function reasoningParts(msg: Record<string, unknown>): any[] {
  const details = msg.reasoning_details;
  const parts =
    Array.isArray(details) && details.length > 0
      ? reasoningPartsFromDetails(details as ReasoningDetail[])
      : [];
  const text =
    typeof msg.reasoning_content === "string"
      ? msg.reasoning_content
      : typeof msg.reasoning === "string"
        ? msg.reasoning
        : "";
  if (text && !parts.some((part) => part.text)) {
    parts.push({ type: "reasoning", text });
  }
  return parts;
}

export function convertOpenAIMessagesToVercel(
  messages: ChatCompletionMessageParam[],
): ConvertedMessages {
  const vercelMessages: VercelCoreMessage[] = [];
  const instructions: string[] = [];

  // tool_call_id → tool name, for the tool results
  const toolCallMap = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.type === "function") {
          toolCallMap.set(tc.id, tc.function.name);
        }
      }
    }
  }

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
      case "developer": {
        const text = textOf(msg.content);
        if (text) instructions.push(text);
        break;
      }

      case "user":
        vercelMessages.push({
          role: "user",
          content: userContent(msg.content),
        });
        break;

      case "assistant": {
        const parts: any[] = reasoningParts(
          msg as unknown as Record<string, unknown>,
        );
        const text = textOf(msg.content);
        if (text) {
          parts.push({ type: "text", text });
        }
        for (const tc of msg.tool_calls ?? []) {
          if (tc.type !== "function") continue;
          let input: unknown;
          try {
            input = JSON.parse(tc.function.arguments || "{}");
          } catch {
            input = tc.function.arguments;
          }
          const thoughtSignature = (tc as any)?.extra_content?.google
            ?.thought_signature as string | undefined;
          parts.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.function.name,
            input,
            ...(thoughtSignature && {
              providerOptions: { google: { thoughtSignature } },
            }),
          });
        }
        const details = (msg as { reasoning_details?: unknown })
          .reasoning_details;
        const compatible: Record<string, unknown> = {};
        if (Array.isArray(details) && details.length > 0) {
          compatible.reasoning_details = details;
        }
        // The compatible provider writes `content: null` for a tool-call
        // message without text; gateways get the caller's "" as before
        if (msg.content === "" && msg.tool_calls?.length) {
          compatible.content = "";
        }
        vercelMessages.push({
          role: "assistant",
          content:
            parts.length === 0 ||
            (parts.length === 1 && parts[0].type === "text")
              ? text
              : parts,
          ...(Object.keys(compatible).length > 0 && {
            providerOptions: { openaiCompatible: compatible },
          }),
        });
        break;
      }

      case "tool": {
        const toolName = toolCallMap.get(msg.tool_call_id) || "unknown_tool";
        vercelMessages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: msg.tool_call_id,
              toolName,
              output: {
                type: "text",
                value:
                  typeof msg.content === "string"
                    ? msg.content
                    : textOf(msg.content) || JSON.stringify(msg.content),
              },
            },
          ],
        });
        break;
      }
    }
  }

  return {
    ...(instructions.length > 0 && { instructions: instructions.join("\n\n") }),
    messages: vercelMessages,
  };
}
