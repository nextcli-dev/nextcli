import { describe, expect, it } from "vitest";

import { CompletionStreamer } from "./CompletionStreamer";

function fakeLlm(thinkingModes: string[], supportsFim = false) {
  const calls: { kind: string; options: any }[] = [];
  const llm: any = {
    supportsFim: () => supportsFim,
    getModelControls: () => ({ thinkingModes }),
    async *streamComplete(_prompt: string, _signal: AbortSignal, options: any) {
      calls.push({ kind: "complete", options });
      yield "x";
    },
    async *streamFim(
      _prefix: string,
      _suffix: string,
      _signal: AbortSignal,
      options: any,
    ) {
      calls.push({ kind: "fim", options });
      yield "x";
    },
  };
  return { llm, calls };
}

async function run(llm: any, completionOptions?: any) {
  const streamer = new CompletionStreamer(() => {});
  const helper: any = { options: { transform: false, modelTimeout: 1000 } };
  const out: string[] = [];
  for await (const chunk of streamer.streamCompletionWithFilters(
    new AbortController().signal,
    llm,
    "prefix",
    "suffix",
    "prompt",
    false,
    completionOptions,
    helper,
  )) {
    out.push(chunk);
  }
  return out;
}

describe("CompletionStreamer chat-based autocomplete", () => {
  it("turns thinking off where the model allows it (DeepSeek V4)", async () => {
    const { llm, calls } = fakeLlm(["off", "hidden", "shown"]);
    await run(llm);
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe("complete");
    expect(calls[0].options).toMatchObject({ thinking: "off", raw: true });
  });

  it("leaves thinking alone where it can't be turned off (Opus 5.5)", async () => {
    const { llm, calls } = fakeLlm(["hidden", "shown"]);
    await run(llm);
    expect(calls[0].options.thinking).toBeUndefined();
  });

  it("lets configured completion options win", async () => {
    const { llm, calls } = fakeLlm(["off", "hidden", "shown"]);
    await run(llm, { thinking: "shown" });
    expect(calls[0].options.thinking).toBe("shown");
  });

  it("uses FIM, untouched, where the endpoint serves it", async () => {
    const { llm, calls } = fakeLlm(["off", "hidden", "shown"], true);
    await run(llm);
    expect(calls[0].kind).toBe("fim");
    expect(calls[0].options).toBeUndefined();
  });
});
