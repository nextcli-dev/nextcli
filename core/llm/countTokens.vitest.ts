import { describe, expect, test } from "vitest";

import { ChatMessage } from "../index.js";
import { countTokens, getTokenCountingBufferSafety } from "./countTokens.js";
import { BaseLLM } from "./index.js";
import LlamaCpp from "./llms/LlamaCpp.js";
import Llamafile from "./llms/Llamafile.js";
import LMStudio from "./llms/LMStudio.js";
import Msty from "./llms/Msty.js";
import Ollama from "./llms/Ollama.js";
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

type LLMClass = new (options: any) => BaseLLM;

/** Compiles a conversation for a provider, at its default API base or the one given */
function compileWith(
  Provider: LLMClass,
  messages: ChatMessage[],
  apiBase?: string,
) {
  const llm = new Provider({
    model: MODEL,
    apiKey: "k",
    ...(apiBase && { apiBase }),
    contextLength: CONTEXT_LENGTH,
    completionOptions: { model: MODEL, maxTokens: MAX_TOKENS },
  });
  return llm.compileChatMessages(messages, {});
}

/** Fits beside the whole max_tokens the request is sent */
const leavesMaxTokens = (messages: ChatMessage[]) =>
  tokensOf(messages) +
    MAX_TOKENS +
    getTokenCountingBufferSafety(CONTEXT_LENGTH) <=
  CONTEXT_LENGTH;

describe("compileChatMessages", () => {
  test.each([
    ["a hosted API", "https://api.example.com/v1/"],
    // A gateway on this machine to Qwen, DeepSeek, Kimi, GLM or any other
    // hosted model rejects input plus max_tokens past the window too
    [
      "an OpenAI-compatible endpoint on this machine",
      "http://localhost:4000/v1/",
    ],
  ])("leaves %s the whole max_tokens it is sent", (_, apiBase) => {
    const { compiledChatMessages, didPrune } = compileWith(
      OpenAI,
      conversation(15),
      apiBase,
    );

    // About 30K of history: with 1,000 kept for the answer it fitted whole,
    // and input plus max_tokens went past the window
    expect(didPrune).toBe(true);
    expect(leavesMaxTokens(compiledChatMessages)).toBe(true);
    expect(compiledChatMessages.at(-1)?.content).toBe("the newest question");
  });

  test.each([
    ["Ollama", Ollama],
    ["Msty", Msty],
    ["LM Studio", LMStudio],
    ["llama.cpp", LlamaCpp],
    ["Llamafile", Llamafile],
  ] as [string, LLMClass][])(
    "keeps today's history for %s, which cuts the answer short instead",
    (_, Provider) => {
      const messages = conversation(15);

      const local = compileWith(Provider, messages);
      const hosted = compileWith(
        OpenAI,
        messages,
        "https://api.example.com/v1/",
      );

      // Only 1,000 tokens are kept for the answer, so more history stays
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

    const { compiledChatMessages, didPrune } = compileWith(
      OpenAI,
      messages,
      "https://api.example.com/v1/",
    );

    expect(didPrune).toBe(false);
    expect(compiledChatMessages).toHaveLength(messages.length);
  });
});
