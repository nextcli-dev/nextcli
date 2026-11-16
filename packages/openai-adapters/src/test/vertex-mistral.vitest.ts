import { afterEach, describe, expect, it, vi } from "vitest";

const requests = vi.hoisted(
  () => [] as Array<{ url: string; init: { headers: any; body: string } }>,
);

vi.mock("../util.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util.js")>();
  return {
    ...actual,
    customFetch: () => async (url: string, init: any) => {
      requests.push({ url, init });
      const chunk = {
        id: "c",
        object: "chat.completion.chunk",
        created: 0,
        model: "mistral-medium-3",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    },
  };
});

import { VertexAIApi } from "../apis/VertexAI.js";

describe("VertexAIApi Mistral streaming", () => {
  afterEach(() => {
    requests.length = 0;
  });

  it("sends the Google token to Vertex's own endpoint, and nowhere else", async () => {
    const api = new VertexAIApi({
      provider: "vertexai",
      env: { region: "europe-west4", projectId: "proj" },
    });
    (api as any).clientPromise = Promise.resolve({
      getAccessToken: async () => ({ token: "google-token" }),
    });

    const chunks = [];
    for await (const chunk of api.chatCompletionStream(
      {
        model: "mistral-medium-3",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://europe-west4-aiplatform.googleapis.com/v1/projects/proj/locations/europe-west4/publishers/mistralai/models/mistral-medium-3:streamRawPredict",
    );
    expect(requests[0].init.headers.Authorization).toBe("Bearer google-token");
    expect(JSON.parse(requests[0].init.body)).toMatchObject({
      model: "mistral-medium-3",
      stream: true,
    });
    expect(chunks.map((c) => c.choices[0]?.delta?.content)).toEqual(["hi"]);
  });
});
