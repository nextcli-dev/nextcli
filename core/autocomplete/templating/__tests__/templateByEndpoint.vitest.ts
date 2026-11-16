import { describe, expect, it, vi } from "vitest";

// Snippets aren't what these tests are about
vi.mock("../filtering", () => ({ getSnippets: () => [] }));
vi.mock("../formatting", () => ({ formatSnippets: () => "" }));

import { renderPromptWithTokenLimit } from "..";
import type { ILLM } from "../../..";
import Deepseek from "../../../llm/llms/Deepseek";
import Ollama from "../../../llm/llms/Ollama";
import OpenAI from "../../../llm/llms/OpenAI";
import Vllm from "../../../llm/llms/Vllm";
import { SnippetPayload } from "../../snippets";
import { HelperVars } from "../../util/HelperVars";

const DEEPSEEK_FIM_TOKEN = "<｜fim▁begin｜>";
const HOLE_FILLER = "You are a HOLE FILLER";

const emptySnippetPayload: SnippetPayload = {
  rootPathSnippets: [],
  importDefinitionSnippets: [],
  ideSnippets: [],
  recentlyEditedRangeSnippets: [],
  recentlyVisitedRangesSnippets: [],
  diffSnippets: [],
  clipboardSnippets: [],
  recentlyOpenedFileSnippets: [],
  staticSnippet: [],
};

function helperFor(llm: ILLM, template?: string): HelperVars {
  return {
    input: {
      filepath: "file:///repo/sum.py",
      pos: { line: 1, character: 2 },
      recentlyEditedRanges: [],
      recentlyVisitedRanges: [],
    },
    prunedPrefix: "def total(xs):\n  ",
    prunedSuffix: "\n  return t\n",
    lang: {
      name: "Python",
      topLevelKeywords: [],
      singleLineComment: "#",
      endOfLine: [],
    },
    modelName: llm.model,
    filepath: "file:///repo/sum.py",
    workspaceUris: [],
    options: { template },
  } as unknown as HelperVars;
}

function render(llm: ILLM, template?: string) {
  return renderPromptWithTokenLimit({
    snippetPayload: emptySnippetPayload,
    workspaceDirs: ["file:///repo"],
    helper: helperFor(llm, template),
    llm,
  });
}

function chatResponse() {
  const encoder = new TextEncoder();
  const chunk = {
    id: "1",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-v4-pro",
    choices: [{ index: 0, delta: { content: "t = sum(xs)" } }],
  };
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`),
        );
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

/** Sends the prompt the way CompletionStreamer does on a non-FIM endpoint */
async function sendCompletion(llm: OpenAI, prompt: string) {
  const fetchMock = vi.fn().mockResolvedValue(chatResponse());
  (llm as any).fetch = fetchMock;
  for await (const _ of llm.streamComplete(
    prompt,
    new AbortController().signal,
    { raw: true },
  )) {
    // drain
  }
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  return { url: String(url), body: JSON.parse(init.body) };
}

describe("autocomplete prompt by endpoint", () => {
  it("DeepSeek through OneProvider gets the hole-filler prompt on chat/completions", async () => {
    const llm = new Deepseek({
      model: "deepseek-v4-pro",
      apiKey: "k",
      apiBase: "https://api.oneprovider.dev/v1",
    });
    const { prompt, completionOptions } = render(llm);

    expect(prompt).toContain(HOLE_FILLER);
    expect(prompt).not.toContain(DEEPSEEK_FIM_TOKEN);
    expect(completionOptions?.stop).toContain("</COMPLETION>");

    const { url, body } = await sendCompletion(llm, prompt);
    expect(url).toBe("https://api.oneprovider.dev/v1/chat/completions");
    const sent = JSON.stringify(body.messages);
    expect(sent).toContain(HOLE_FILLER);
    expect(sent).not.toContain(DEEPSEEK_FIM_TOKEN);
  });

  // What nextcli-checks writes, and what CompletionProvider turns into a
  // legacy-completions request for every OpenAI-family model
  it("an openai config on OneProvider sends chat, not /completions", async () => {
    const llm = new OpenAI({
      model: "deepseek-v4-pro",
      apiKey: "k",
      apiBase: "https://api.oneprovider.dev/v1",
    });
    llm.useLegacyCompletionsEndpoint = true;
    expect(llm.supportsCompletions()).toBe(false);

    const { prompt } = render(llm);
    expect(prompt).toContain(HOLE_FILLER);

    const { url, body } = await sendCompletion(llm, prompt);
    expect(url).toBe("https://api.oneprovider.dev/v1/chat/completions");
    expect(body.prompt).toBeUndefined();
  });

  it("DeepSeek's own API keeps FIM and its FIM template", () => {
    const llm = new Deepseek({ model: "deepseek-v4-pro", apiKey: "k" });
    expect(llm.supportsFim()).toBe(true);
    expect(render(llm).prompt).toContain(DEEPSEEK_FIM_TOKEN);
  });

  it("local servers keep the template chosen by model name", () => {
    const ollama = new Ollama({ model: "codellama:7b-code" });
    expect(ollama.supportsCompletions()).toBe(true);
    expect(render(ollama).prompt).toContain("<PRE>");

    const vllm = new Vllm({
      model: "deepseek-coder-v2-lite-base",
      apiBase: "http://localhost:8000/v1",
    });
    expect(vllm.supportsCompletions()).toBe(true);
    expect(render(vllm).prompt).toContain(DEEPSEEK_FIM_TOKEN);
  });

  it("a configured template wins on a chat-only endpoint", () => {
    const llm = new Deepseek({
      model: "deepseek-v4-pro",
      apiKey: "k",
      apiBase: "https://api.oneprovider.dev/v1",
    });
    const { prompt } = render(llm, "MINE {{{prefix}}}");
    expect(prompt.startsWith("MINE ")).toBe(true);
    expect(prompt).not.toContain(HOLE_FILLER);
  });
});
