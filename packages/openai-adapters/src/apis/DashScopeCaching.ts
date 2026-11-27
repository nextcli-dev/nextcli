import { catalogProviderForApiBase } from "@nextcli/llm-info";
import type {
  ChatCompletionContentPartText,
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from "openai/resources/index";

/**
 * Alibaba's Qwen hosts (DashScope, Qwen Cloud, their token and coding plans)
 * cache only up to a cache_control marker on a message's text part. Without
 * one they cache implicitly, in 256-token blocks and never the newest part.
 */
export function isDashScopeApiBase(apiBase: string | undefined): boolean {
  return !!catalogProviderForApiBase(apiBase)?.startsWith("alibaba");
}

type CachedTextPart = ChatCompletionContentPartText & {
  cache_control?: { type: "ephemeral" };
};

const EPHEMERAL = { type: "ephemeral" } as const;

/** A copy of the message with its last text part marked, if it has one */
function withMarker(
  message: ChatCompletionMessageParam,
): ChatCompletionMessageParam | undefined {
  const { content } = message as { content?: unknown };
  if (typeof content === "string") {
    const parts: CachedTextPart[] = [
      { type: "text", text: content, cache_control: EPHEMERAL },
    ];
    return content
      ? ({ ...message, content: parts } as typeof message)
      : undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const index = content.findLastIndex(
    (part: { type?: string; text?: string }) =>
      part?.type === "text" && !!part.text,
  );
  if (index < 0) {
    return undefined;
  }
  const parts = [...content];
  parts[index] = { ...parts[index], cache_control: EPHEMERAL };
  return { ...message, content: parts } as typeof message;
}

/**
 * The same places A1 marks for Claude: the system message, and the last two
 * user or tool messages. A tool loop's newest message is a tool result, so
 * each round reads what the round before wrote and writes only what's new.
 * The caller's messages are left as they were.
 */
export function addDashScopeCacheMarkers<T extends ChatCompletionCreateParams>(
  body: T,
): T {
  const messages = [...body.messages];
  const mark = (index: number) => {
    const marked = withMarker(messages[index]!);
    if (marked) {
      messages[index] = marked;
    }
    return !!marked;
  };
  const system = messages.findIndex(
    (message) => message.role === "system" || message.role === "developer",
  );
  if (system >= 0) {
    mark(system);
  }
  let marked = 0;
  for (let index = messages.length - 1; index >= 0 && marked < 2; index--) {
    const { role } = messages[index]!;
    if ((role === "user" || role === "tool") && mark(index)) {
      marked++;
    }
  }
  body.messages = messages;
  return body;
}
