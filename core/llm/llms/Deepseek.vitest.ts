import { describe, expect, test, vi } from "vitest";

import Deepseek from "./Deepseek.js";

function sseResponse(chunks: unknown[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("DeepSeek through OneProvider", () => {
  const llm = new Deepseek({
    model: "deepseek-v4-pro",
    apiKey: "k",
    apiBase: "https://api.oneprovider.dev",
  });

  test("has no FIM, so autocomplete uses chat", () => {
    expect(llm.supportsFim()).toBe(false);
  });

  test("chat-based completion with thinking off sends disabled thinking to chat/completions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        {
          id: "1",
          object: "chat.completion.chunk",
          created: 0,
          model: "deepseek-v4-pro",
          choices: [{ index: 0, delta: { content: "ok" } }],
        },
      ]),
    );
    (llm as any).fetch = fetchMock;

    for await (const _ of llm.streamComplete(
      "def f(",
      new AbortController().signal,
      { thinking: "off", raw: true },
    )) {
      // drain
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // OneProvider serves chat/completions with and without /v1
    expect(String(url)).toBe("https://api.oneprovider.dev/chat/completions");
    expect(String(url)).not.toContain("beta/completions");
    const body = JSON.parse(init.body);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(Object.keys(body).some((k) => k.startsWith("nextcli_"))).toBe(false);
  });
});
