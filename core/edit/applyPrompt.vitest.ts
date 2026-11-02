import { describe, expect, it, vi } from "vitest";

import { ChatMessage } from "..";
import MockLLM from "../llm/llms/Mock";
import { defaultApplyPrompt } from "../llm/templates/edit/gpt";
import { recursiveStream } from "./recursiveStream";
import { streamDiffLines } from "./streamDiffLines";

function mockLlm(
  model: string,
  { prefill, completions }: { prefill: boolean; completions: boolean },
) {
  const llm = new MockLLM({ model });
  llm.completion = "const a = 2;";
  vi.spyOn(llm, "supportsPrefill").mockReturnValue(prefill);
  vi.spyOn(llm, "supportsCompletions").mockReturnValue(completions);
  return llm;
}

async function runApply(llm: MockLLM) {
  const lines = [];
  for await (const line of streamDiffLines(
    {
      type: "apply",
      prefix: "",
      highlighted: "const a = 1;",
      suffix: "",
      input: "",
      language: "typescript",
      newCode: "const a = 2;",
      modelTitle: "mock",
      includeRulesInSystemMessage: false,
      fileUri: "file:///a.ts",
    },
    llm,
    new AbortController(),
    undefined,
    undefined,
  )) {
    lines.push(line);
  }
  return lines;
}

describe("defaultApplyPrompt", () => {
  const data = { original_code: "a", new_code: "b" };

  it("prefills the opening fence when the provider allows it", () => {
    const messages = defaultApplyPrompt([], {
      ...data,
      supportsPrefill: "true",
    }) as ChatMessage[];
    expect(messages.at(-1)).toEqual({ role: "assistant", content: "```\n" });
  });

  it("ends on the user message when the provider rejects prefill", () => {
    const messages = defaultApplyPrompt([], {
      ...data,
      supportsPrefill: "false",
    }) as ChatMessage[];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });
});

describe("apply routing (#9379, #7143)", () => {
  it("uses chat, not a flattened raw completion, without prefill", async () => {
    // qwen would be flattened into a ChatML string if the prefill stayed
    const llm = mockLlm("qwen3", { prefill: false, completions: true });
    const chat = vi.spyOn(llm, "streamChat");
    const complete = vi.spyOn(llm, "streamComplete");

    await runApply(llm);

    expect(chat).toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    const sent = chat.mock.calls[0][0];
    expect(sent.at(-1)?.role).toBe("user");
  });

  it("keeps the prefilled chat prompt when the provider allows it", async () => {
    const llm = mockLlm("qwen3", { prefill: true, completions: true });
    const chat = vi.spyOn(llm, "streamChat");
    const complete = vi.spyOn(llm, "streamComplete");

    await runApply(llm);

    expect(complete).not.toHaveBeenCalled();
    expect(chat.mock.calls[0][0].at(-1)).toEqual({
      role: "assistant",
      content: "```\n",
    });
  });

  it("sends a string prompt as chat when completions are unsupported", async () => {
    const llm = mockLlm("custom", { prefill: false, completions: false });
    const chat = vi.spyOn(llm, "streamChat");
    const complete = vi.spyOn(llm, "streamComplete");

    const chunks = [];
    for await (const chunk of recursiveStream(
      llm,
      new AbortController(),
      "apply",
      "raw prompt",
      undefined,
    )) {
      chunks.push(chunk);
    }

    expect(complete).not.toHaveBeenCalled();
    expect(chat.mock.calls[0][0]).toEqual([
      { role: "user", content: "raw prompt" },
    ]);
  });

  it("keeps a string prompt as a raw completion when supported", async () => {
    const llm = mockLlm("custom", { prefill: false, completions: true });
    const complete = vi.spyOn(llm, "streamComplete");

    for await (const _ of recursiveStream(
      llm,
      new AbortController(),
      "apply",
      "raw prompt",
      undefined,
    )) {
      // drain
    }

    expect(complete).toHaveBeenCalled();
  });
});
