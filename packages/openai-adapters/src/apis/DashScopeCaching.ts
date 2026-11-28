import { catalogProviderForApiBase, findCatalogModel } from "@nextcli/llm-info";
import type {
  ChatCompletionContentPartText,
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from "openai/resources/index";

/**
 * Alibaba's hosts (DashScope, Qwen Cloud, their token and coding plans) cache
 * a model with explicit caching up to a cache_control marker on a message's
 * text part. Without one they cache implicitly, in 256-token blocks and
 * never the newest part. Which models have explicit caching differs by
 * model and region; the catalog lists a cache-write price for exactly those.
 */
export function takesCacheMarkers(
  apiBase: string | undefined,
  model: string,
): boolean {
  const provider = catalogProviderForApiBase(apiBase);
  return (
    !!provider?.startsWith("alibaba") &&
    findCatalogModel(provider, model)?.model.cost?.cacheWrite !== undefined
  );
}

const EPHEMERAL = { type: "ephemeral" } as const;

/** A copy of the message with its last text part marked, if it has one */
function withMarker(
  message: ChatCompletionMessageParam,
): ChatCompletionMessageParam | undefined {
  const { content } = message as { content?: unknown };
  if (typeof content === "string") {
    return content
      ? ({
          ...message,
          content: [
            {
              type: "text",
              text: content,
              cache_control: EPHEMERAL,
            } as ChatCompletionContentPartText,
          ],
        } as typeof message)
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
 * Marks the system message, the newest user or tool message, and the last
 * user or tool message before the newest assistant message: where the
 * request before this one ended and wrote its cache. So each request reads
 * that cache at its own marker and writes only what's new, however many
 * tool results one parallel round added. The caller's messages are left as
 * they were.
 */
export function addDashScopeCacheMarkers(
  body: ChatCompletionCreateParams,
): void {
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
  const markLast = (before: number) => {
    for (let index = before - 1; index >= 0; index--) {
      const { role } = messages[index]!;
      if ((role === "user" || role === "tool") && mark(index)) {
        return;
      }
    }
  };
  markLast(messages.length);
  markLast(messages.findLastIndex((message) => message.role === "assistant"));
  body.messages = messages;
}
