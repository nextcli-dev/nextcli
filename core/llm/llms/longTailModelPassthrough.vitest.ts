import { describe, expect, test, vi } from "vitest";

import Cerebras from "./Cerebras.js";
import Fireworks from "./Fireworks.js";
import FunctionNetwork from "./FunctionNetwork.js";
import Groq from "./Groq.js";
import NCompass from "./NCompass.js";
import Nebius from "./Nebius.js";
import Novita from "./Novita.js";
import OpenAI from "./OpenAI.js";
import OVHcloud from "./OVHcloud.js";
import Replicate from "./Replicate.js";
import SambaNova from "./SambaNova.js";
import Scaleway from "./Scaleway.js";
import Together from "./Together.js";

// These providers used to carry static friendly-name -> vendor-id maps
// (e.g. Groq "llama3-8b" -> "llama3-8b-8192"). The configured model id must
// now reach the vendor unchanged.

function sseResponse() {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "ok" }, text: "ok" }],
          })}\n\n`,
        ),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function mockLlm(llm: OpenAI) {
  const fetchMock = vi.fn().mockImplementation(async () => sseResponse());
  (llm as any).fetch = fetchMock;
  (llm as any).useOpenAIAdapterFor = [];
  return fetchMock;
}

function sentModel(fetchMock: ReturnType<typeof vi.fn>): string {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [, init] = fetchMock.mock.calls[0];
  return JSON.parse(init.body as string).model;
}

const providers: [string, typeof OpenAI, string][] = [
  ["groq", Groq, "llama3-8b"],
  ["together", Together, "llama3-8b"],
  ["nebius", Nebius, "llama3.1-70b"],
  ["novita", Novita, "llama3-8b"],
  ["sambanova", SambaNova, "llama3.3-70b"],
  ["cerebras", Cerebras, "qwen-3-coder-480b-free"],
  ["ovhcloud", OVHcloud, "llama3.1-8b"],
  ["scaleway", Scaleway, "llama3.1-8b"],
  ["ncompass", NCompass, "qwen2.5-coder-7b"],
  ["fireworks", Fireworks, "starcoder-7b"],
  ["function-network", FunctionNetwork, "llama3-8b"],
];

describe("long-tail providers pass the model id through unchanged", () => {
  test.each(providers)(
    "%s sends the configured model id",
    async (_name, ProviderClass, model) => {
      const llm = new ProviderClass({ apiKey: "k", model });
      const fetchMock = mockLlm(llm);

      for await (const _ of llm.streamChat(
        [{ role: "user", content: "hi" }],
        new AbortController().signal,
      )) {
      }

      expect(sentModel(fetchMock)).toBe(model);
    },
  );

  test("together uses the per-request model, not this.model", async () => {
    const llm = new Together({ apiKey: "k", model: "configured/model" });
    const fetchMock = mockLlm(llm);

    for await (const _ of llm.streamComplete(
      "hi",
      new AbortController().signal,
      { model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
    )) {
    }

    expect(sentModel(fetchMock)).toBe(
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    );
  });

  test("replicate sends the configured model id", async () => {
    const llm = new Replicate({ apiKey: "k", model: "codellama-7b" });
    const stream = vi.fn().mockImplementation(async function* () {
      yield { event: "output", data: "ok" };
    });
    (llm as any)._replicate = { stream };

    for await (const _ of llm.streamChat(
      [{ role: "user", content: "hi" }],
      new AbortController().signal,
    )) {
    }

    expect(stream).toHaveBeenCalledTimes(1);
    expect(stream.mock.calls[0][0]).toBe("codellama-7b");
  });
});
