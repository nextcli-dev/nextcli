import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { AiSdkApi } from "@nextcli/openai-adapters";
import { afterEach, describe, expect, it } from "vitest";

import { withExponentialBackoff } from "./exponentialBackoff.js";

/**
 * The CLI's retries decide from the error's HTTP status. These run a real
 * AI-SDK request against a local server, so the status has to survive the
 * AI SDK and the adapter's error formatting.
 */

const CHAT_STREAM =
  [
    { choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]
    .map(
      (chunk) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", ...chunk })}\n\n`,
    )
    .join("") + "data: [DONE]\n\n";

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

/** Answers each request with the next status; 200 streams a reply */
async function serve(statuses: number[]): Promise<{
  apiBase: string;
  hits: () => number;
}> {
  let hits = 0;
  server = createServer((req, res) => {
    req.resume();
    const status = statuses[Math.min(hits, statuses.length - 1)];
    hits++;
    if (status === 200) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(CHAT_STREAM);
      return;
    }
    // retry-after-ms: 0 makes the AI SDK's own retries immediate
    res.writeHead(status, {
      "content-type": "application/json",
      "retry-after-ms": "0",
    });
    res.end(JSON.stringify({ error: { message: `status ${status}` } }));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { apiBase: `http://127.0.0.1:${port}/v1`, hits: () => hits };
}

function stream(apiBase: string) {
  const api = new AiSdkApi({
    provider: "ai-sdk",
    model: "openrouter/some-model",
    apiKey: "k",
    apiBase,
  });
  return withExponentialBackoff(
    async (signal) =>
      api.chatCompletionStream(
        {
          model: "some-model",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
        signal,
      ),
    new AbortController().signal,
    { initialDelay: 1, jitter: false, hiddenRetries: 10 },
  );
}

async function contentOf(chunks: AsyncGenerator<any>): Promise<string> {
  let content = "";
  for await (const chunk of chunks) {
    content += chunk.choices?.[0]?.delta?.content ?? "";
  }
  return content;
}

describe("CLI retries on the AI-SDK path", () => {
  it("backs off on a rate limit that outlasts the AI SDK's own retries", async () => {
    // The AI SDK tries three times (two retries); the fourth request is the
    // CLI's retry
    const { apiBase, hits } = await serve([429, 429, 429, 200]);
    await expect(contentOf(stream(apiBase))).resolves.toBe("ok");
    expect(hits()).toBe(4);
  });

  it("does not retry a bad key", async () => {
    const { apiBase, hits } = await serve([401]);
    await expect(contentOf(stream(apiBase))).rejects.toMatchObject({
      status: 401,
    });
    expect(hits()).toBe(1);
  });
});
