/**
 * Which endpoint autocomplete, edit and apply use on hosts with and without a
 * legacy /completions route, through the code that picks it: CompletionProvider
 * prepares the model, the autocomplete prompt is rendered for it, and
 * recursiveStream sends edit prompts. Requests go to a local server.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ILLM } from "../..";
import { CompletionProvider } from "../../autocomplete/CompletionProvider";
import { renderPromptWithTokenLimit } from "../../autocomplete/templating";
import type { HelperVars } from "../../autocomplete/util/HelperVars";
import { recursiveStream } from "../../edit/recursiveStream";
import { osModelsEditPrompt } from "../templates/edit";

import { LLMClasses } from "./index";

let server: http.Server;
let apiBase: string;
const paths: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      paths.push(new URL(req.url!, "http://localhost").pathname);
      const chunk = req.url!.endsWith("/chat/completions")
        ? {
            id: "c",
            object: "chat.completion.chunk",
            created: 0,
            model: "m",
            choices: [{ index: 0, delta: { content: "x" } }],
          }
        : {
            id: "c",
            object: "text_completion",
            created: 0,
            model: "m",
            choices: [{ index: 0, text: "x", finish_reason: null }],
          };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

function llm(provider: string, model: string, options: object = {}): any {
  const cls = LLMClasses.find((c) => c.providerName === provider)!;
  return new (cls as any)({ model, apiKey: "k", apiBase, ...options });
}

/** The model as autocomplete gets it: CompletionProvider._prepareLlm */
async function prepared(instance: ILLM): Promise<any> {
  return (CompletionProvider.prototype as any)._prepareLlm.call({
    _injectedGetLlm: async () => instance,
  });
}

/** The path the request went to: completions or chat/completions */
async function sentTo(run: () => AsyncIterable<unknown>): Promise<string> {
  paths.length = 0;
  for await (const _ of run()) {
    // drain
  }
  expect(paths).toHaveLength(1);
  return paths[0].replace("/v1/", "");
}

async function autocompleteSentTo(instance: ILLM): Promise<string> {
  const model = await prepared(instance);
  return sentTo(() =>
    model.streamComplete("def add(a, b):", new AbortController().signal, {
      raw: true,
    }),
  );
}

function autocompletePrompt(instance: ILLM, modelName: string): string {
  const helper = {
    input: {
      filepath: "file:///a.py",
      pos: { line: 0, character: 0 },
      recentlyEditedRanges: [],
      recentlyVisitedRanges: [],
    },
    prunedPrefix: "def add(a, b):\n    ",
    prunedSuffix: "\n",
    lang: { name: "Python", topLevelKeywords: [], singleLineComment: "#" },
    modelName,
    filepath: "file:///a.py",
    workspaceUris: [],
    options: {
      template: undefined,
      maxPromptTokens: 2048,
      prefixPercentage: 0.5,
      maxSuffixPercentage: 0.5,
    },
  } as unknown as HelperVars;
  return renderPromptWithTokenLimit({
    snippetPayload: {
      rootPathSnippets: [],
      importDefinitionSnippets: [],
      ideSnippets: [],
      recentlyEditedRangeSnippets: [],
      recentlyVisitedRangesSnippets: [],
      diffSnippets: [],
      clipboardSnippets: [],
      recentlyOpenedFileSnippets: [],
      staticSnippet: [],
    },
    workspaceDirs: [],
    helper,
    llm: instance,
  }).prompt;
}

const CODER = "qwen-2.5-coder-32b-instruct";

describe("autocomplete", () => {
  it("keeps /completions where the host serves it", async () => {
    expect(await autocompleteSentTo(llm("openrouter", `qwen/${CODER}`))).toBe(
      "completions",
    );
    expect(await autocompleteSentTo(llm("nebius", `Qwen/${CODER}`))).toBe(
      "completions",
    );
    // A chat-only model name goes to chat wherever it is served
    expect(await autocompleteSentTo(llm("openrouter", "openai/gpt-5.5"))).toBe(
      "chat/completions",
    );
  });

  it("uses chat where the host has no /completions", async () => {
    for (const provider of ["minimax", "moonshot", "zAI"]) {
      expect(await autocompleteSentTo(llm(provider, CODER)), provider).toBe(
        "chat/completions",
      );
    }
  });

  it("follows a model config that turns /completions off", async () => {
    // CompletionProvider sets the instance field to true; the config wins
    const instance = llm("nebius", `Qwen/${CODER}`, {
      useLegacyCompletionsEndpoint: false,
    });
    expect(await autocompleteSentTo(instance)).toBe("chat/completions");
  });

  it("renders the model's FIM template where /completions or FIM is served, else the hole filler", () => {
    expect(
      autocompletePrompt(llm("openrouter", `qwen/${CODER}`), CODER),
    ).toContain("<|fim_prefix|>");
    const siliconflow = llm("siliconflow", `Qwen/${CODER}`);
    expect(siliconflow.supportsFim()).toBe(true);
    expect(autocompletePrompt(siliconflow, CODER)).toContain("<|fim_prefix|>");
    expect(autocompletePrompt(llm("minimax", CODER), CODER)).toContain(
      "HOLE FILLER",
    );
  });
});

describe("edit", () => {
  const data = {
    userInput: "rename it",
    prefix: "",
    codeToEdit: "def add(a, b): return a + b",
    suffix: "",
    language: "python",
  };

  // The open-model edit prompt puts words in the model's mouth, so it needs
  // /completions (or prefill); without either it falls back to the GPT
  // edit prompt
  it("keeps the open-model edit prompt where /completions is served", () => {
    for (const provider of [
      "openrouter",
      "nebius",
      "siliconflow",
      "llamastack",
    ]) {
      expect(
        llm(provider, CODER).renderPromptTemplate(osModelsEditPrompt, [], data),
        provider,
      ).toContain("Sure! Here's the entire rewritten code block");
    }
    expect(
      llm("minimax", CODER).renderPromptTemplate(osModelsEditPrompt, [], data),
    ).toContain("Please rewrite the above file");
  });

  it("sends a raw edit prompt to /completions, or as chat where it isn't served", async () => {
    const edit = (instance: ILLM) => () =>
      recursiveStream(
        instance,
        new AbortController(),
        "edit",
        "Rewrite: def add(a, b):",
        undefined,
      );
    expect(await sentTo(edit(llm("openrouter", `qwen/${CODER}`)))).toBe(
      "completions",
    );
    expect(await sentTo(edit(llm("minimax", CODER)))).toBe("chat/completions");
  });
});

describe("supportsCompletions", () => {
  it("is off only where the host has no /completions or the config says so", () => {
    for (const provider of [
      "openrouter",
      "nebius",
      "siliconflow",
      "llamastack",
      "scaleway",
      "ovhcloud",
      "nvidia",
      "tensorix",
      "nous",
      "together",
    ]) {
      expect(llm(provider, CODER).supportsCompletions(), provider).toBe(true);
    }
    for (const provider of ["minimax", "moonshot", "zAI"]) {
      expect(llm(provider, CODER).supportsCompletions(), provider).toBe(false);
    }
    expect(
      llm("openai", CODER, {
        useLegacyCompletionsEndpoint: false,
      }).supportsCompletions(),
    ).toBe(false);
  });
});
