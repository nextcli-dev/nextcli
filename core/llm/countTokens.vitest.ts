import { describe, expect, test } from "vitest";

import { ChatMessage } from "../index.js";
import { countTokens, getTokenCountingBufferSafety } from "./countTokens.js";
import OpenAI from "./llms/OpenAI.js";

const MODEL = "gpt-4";
const CONTEXT_LENGTH = 32_000;
const MAX_TOKENS = 8_000;

/** A conversation of `turns` user/assistant pairs, each message about 1,000 tokens */
function conversation(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `${i} ${"word ".repeat(1_000)}` });
    messages.push({
      role: "assistant",
      content: `${i} ${"word ".repeat(1_000)}`,
    });
  }
  messages.push({ role: "user", content: "the newest question" });
  return messages;
}

// Content only, a little under what the request carries
const tokensOf = (messages: ChatMessage[]) =>
  messages.reduce((sum, m) => sum + countTokens(String(m.content), MODEL), 0);

/** Compiles a conversation for a model served at apiBase */
function compileAt(apiBase: string, messages: ChatMessage[]) {
  const llm = new OpenAI({
    model: MODEL,
    apiKey: "k",
    apiBase,
    contextLength: CONTEXT_LENGTH,
    completionOptions: { model: MODEL, maxTokens: MAX_TOKENS },
  });
  return llm.compileChatMessages(messages, {});
}

describe("compileChatMessages", () => {
  test("leaves a hosted API the whole max_tokens it is sent", () => {
    const { compiledChatMessages, didPrune } = compileAt(
      "https://api.example.com/v1/",
      conversation(15),
    );

    // About 30K of history: with 1,000 kept for the answer it fitted whole,
    // and input plus max_tokens went past the window
    expect(didPrune).toBe(true);
    expect(
      tokensOf(compiledChatMessages) +
        MAX_TOKENS +
        getTokenCountingBufferSafety(CONTEXT_LENGTH),
    ).toBeLessThanOrEqual(CONTEXT_LENGTH);
    expect(compiledChatMessages.at(-1)?.content).toBe("the newest question");
  });

  test.each(["http://localhost:1234/v1/", "http://127.0.0.1:8080/v1/"])(
    "keeps more history for a server on this machine (%s)",
    (apiBase) => {
      const messages = conversation(15);

      const local = compileAt(apiBase, messages);
      const hosted = compileAt("https://api.example.com/v1/", messages);

      // A local server shortens the answer instead of rejecting the request,
      // so it keeps the 1,000-token reserve and the history it allowed
      expect(tokensOf(local.compiledChatMessages)).toBeGreaterThan(
        tokensOf(hosted.compiledChatMessages) + 5_000,
      );
      expect(
        tokensOf(local.compiledChatMessages) +
          1_000 +
          getTokenCountingBufferSafety(CONTEXT_LENGTH),
      ).toBeLessThanOrEqual(CONTEXT_LENGTH);
    },
  );

  test("sends a history that fits beside max_tokens whole", () => {
    const messages = conversation(2);

    const { compiledChatMessages, didPrune } = compileAt(
      "https://api.example.com/v1/",
      messages,
    );

    expect(didPrune).toBe(false);
    expect(compiledChatMessages).toHaveLength(messages.length);
  });
});
