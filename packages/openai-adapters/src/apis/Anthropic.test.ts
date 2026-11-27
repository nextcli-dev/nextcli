import {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from "openai/resources/index";
import { describe, expect, it } from "vitest";

import { CACHING_STRATEGIES } from "./AnthropicCachingStrategies.js";
import { addCacheControlToLastTwoUserMessages } from "./AnthropicUtils.js";
import { AnthropicApi } from "./Anthropic.js";

describe("AnthropicApi", () => {
  describe("_convertBody applies cache_control to last two user messages", () => {
    const api = new AnthropicApi({
      provider: "anthropic",
      apiKey: "test-key",
      cachingStrategy: "systemAndTools",
    });

    it("adds cache_control to the last two user messages", () => {
      const body = api._convertToCleanAnthropicBody({
        model: "claude-sonnet-5-5",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "First user message" },
          { role: "assistant", content: "First response" },
          { role: "user", content: "Second user message" },
          { role: "assistant", content: "Second response" },
          { role: "user", content: "Third user message" },
        ],
      });

      const result = CACHING_STRATEGIES["systemAndTools"](body);
      addCacheControlToLastTwoUserMessages(result.messages);

      // The last user message (index 4 = "Third user message") should have cache_control
      const lastUserMsg = result.messages[4];
      expect(lastUserMsg.role).toBe("user");
      expect(Array.isArray(lastUserMsg.content)).toBe(true);
      if (Array.isArray(lastUserMsg.content)) {
        const textPart = lastUserMsg.content.find(
          (p: any) => p.type === "text",
        );
        expect((textPart as any)?.cache_control).toEqual({ type: "ephemeral" });
      }

      // The second-to-last user message (index 2 = "Second user message") should also have cache_control
      const secondLastUserMsg = result.messages[2];
      expect(secondLastUserMsg.role).toBe("user");
      expect(Array.isArray(secondLastUserMsg.content)).toBe(true);
      if (Array.isArray(secondLastUserMsg.content)) {
        const textPart = secondLastUserMsg.content.find(
          (p: any) => p.type === "text",
        );
        expect((textPart as any)?.cache_control).toEqual({ type: "ephemeral" });
      }

      // The first user message (index 0 = "First user message") should NOT have cache_control
      const firstUserMsg = result.messages[0];
      expect(firstUserMsg.role).toBe("user");
      expect(Array.isArray(firstUserMsg.content)).toBe(true);
      if (Array.isArray(firstUserMsg.content)) {
        const textPart = firstUserMsg.content.find(
          (p: any) => p.type === "text",
        );
        expect((textPart as any)?.cache_control).toBeUndefined();
      }
    });

    it("handles conversations with only one user message", () => {
      const body = api._convertToCleanAnthropicBody({
        model: "claude-sonnet-5-5",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Only user message" },
        ],
      });

      const result = CACHING_STRATEGIES["systemAndTools"](body);
      addCacheControlToLastTwoUserMessages(result.messages);

      const userMsg = result.messages[0];
      expect(userMsg.role).toBe("user");
      expect(Array.isArray(userMsg.content)).toBe(true);
      if (Array.isArray(userMsg.content)) {
        const textPart = userMsg.content.find((p: any) => p.type === "text");
        expect((textPart as any)?.cache_control).toEqual({ type: "ephemeral" });
      }
    });

    it("does not cache user messages when caching strategy is none", () => {
      const api = new AnthropicApi({
        provider: "anthropic",
        apiKey: "test-key",
        cachingStrategy: "none",
      });

      const result = (api as any)._convertBody({
        model: "claude-sonnet-5-5",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi" },
          { role: "user", content: "How are you?" },
        ],
      });

      // No cache_control should be added when strategy is "none"
      const lastUserMsg = result.messages[2];
      expect(lastUserMsg.role).toBe("user");
      if (Array.isArray(lastUserMsg.content)) {
        const textPart = lastUserMsg.content.find(
          (p: any) => p.type === "text",
        );
        expect((textPart as any)?.cache_control).toBeUndefined();
      }
    });
  });
});

describe("caching an agent loop", () => {
  const loop: ChatCompletionCreateParams = {
    model: "claude-sonnet-5-5",
    messages: [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "Fix the failing test." },
      ...["a", "b", "c"].flatMap((id): ChatCompletionMessageParam[] => [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id,
              type: "function",
              function: { name: "Read", arguments: `{"path":"${id}.ts"}` },
            },
          ],
        },
        { role: "tool", tool_call_id: id, content: `contents of ${id}.ts` },
      ]),
    ],
    tools: [
      {
        type: "function",
        function: { name: "Read", parameters: { type: "object" } },
      },
      {
        type: "function",
        function: { name: "Edit", parameters: { type: "object" } },
      },
    ],
  };

  const markedBlocks = (body: unknown): string[] =>
    JSON.stringify(body)
      .split('"cache_control"')
      .slice(0, -1)
      .map((before) => before.slice(before.lastIndexOf('"type":"') + 8))
      .map((rest) => rest.slice(0, rest.indexOf('"')));

  it("marks system, the last tool and the two newest tool results, within 4 breakpoints", () => {
    const api = new AnthropicApi({ provider: "anthropic", apiKey: "k" });
    const body = api._convertBody(loop);

    expect(markedBlocks(body)).toHaveLength(4);
    expect(body.system).toMatchObject([
      { cache_control: { type: "ephemeral" } },
    ]);
    expect(body.tools?.at(-1)).toMatchObject({
      cache_control: { type: "ephemeral" },
    });
    const last = body.messages.at(-1)?.content;
    expect(Array.isArray(last) && last.at(-1)).toMatchObject({
      type: "tool_result",
      tool_use_id: "c",
      cache_control: { type: "ephemeral" },
    });
    const previous = body.messages.at(-3)?.content;
    expect(Array.isArray(previous) && previous.at(-1)).toMatchObject({
      type: "tool_result",
      tool_use_id: "b",
      cache_control: { type: "ephemeral" },
    });
  });

  it("stays within 4 breakpoints when the system message has two blocks", () => {
    const api = new AnthropicApi({ provider: "anthropic", apiKey: "k" });
    const body = api._convertBody({
      ...loop,
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "You are a coding agent." },
            { type: "text", text: "Project rules." },
          ],
        },
        ...loop.messages.slice(1),
      ],
    });

    // Two system blocks and the last tool leave one for the conversation,
    // which goes on the newest tool result
    expect(markedBlocks(body)).toHaveLength(4);
    const last = body.messages.at(-1)?.content;
    expect(Array.isArray(last) && last.at(-1)).toMatchObject({
      tool_use_id: "c",
      cache_control: { type: "ephemeral" },
    });
  });

  it("adds no marker when caching is off", () => {
    const api = new AnthropicApi({
      provider: "anthropic",
      apiKey: "k",
      cachingStrategy: "none",
    });
    expect(markedBlocks(api._convertBody(loop))).toEqual([]);
  });
});
