import { describe, expect, it, vi } from "vitest";

// Snippets aren't what these tests are about
vi.mock("../filtering", () => ({ getSnippets: () => [] }));
vi.mock("../formatting", () => ({ formatSnippets: () => "" }));

import { renderPromptWithTokenLimit } from "..";
import type { ILLM } from "../../..";
import Deepseek from "../../../llm/llms/Deepseek";
import Groq from "../../../llm/llms/Groq";
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

describe("autocomplete prompt by endpoint", () => {
  it("DeepSeek through OneProvider gets the hole-filler prompt", () => {
    const llm = new Deepseek({
      model: "deepseek-v4-pro",
      apiKey: "k",
      apiBase: "https://api.oneprovider.dev/v1",
    });
    const { prompt, completionOptions } = render(llm);

    expect(prompt).toContain(HOLE_FILLER);
    expect(prompt).not.toContain(DEEPSEEK_FIM_TOKEN);
    expect(completionOptions?.stop).toContain("</COMPLETION>");
  });

  // What nextcli-checks writes: /completions 404s on OneProvider
  it("an openai config on OneProvider has no raw completions", () => {
    const llm = new OpenAI({
      model: "deepseek-v4-pro",
      apiKey: "k",
      apiBase: "https://api.oneprovider.dev/v1",
    });
    expect(llm.supportsCompletions()).toBe(false);
    expect(render(llm).prompt).toContain(HOLE_FILLER);
  });

  // Groq serves chat only, so its models get the hole filler instead of the
  // name-based FIM template (StableCode's for most names)
  it("Groq gets the hole-filler prompt", () => {
    const llm = new Groq({ model: "llama-3.3-70b-versatile", apiKey: "k" });
    expect(llm.supportsFim()).toBe(false);
    expect(llm.supportsCompletions()).toBe(false);
    const { prompt } = render(llm);
    expect(prompt).toContain(HOLE_FILLER);
    expect(prompt).not.toContain("<fim_prefix>");
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
