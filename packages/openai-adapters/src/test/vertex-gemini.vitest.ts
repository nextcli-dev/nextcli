import { afterEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; body: any }>,
  parts: [] as any[],
}));

vi.mock("../util.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util.js")>();
  return {
    ...actual,
    customFetch: () => async (url: string, init: any) => {
      server.requests.push({ url, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({
          candidates: [{ content: { role: "model", parts: server.parts } }],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  };
});

import { VertexAIApi } from "../apis/VertexAI.js";

function vertex() {
  const api = new VertexAIApi({
    provider: "vertexai",
    env: { region: "us-central1", projectId: "proj" },
  });
  (api as any).clientPromise = Promise.resolve({
    getAccessToken: async () => ({ token: "google-token" }),
  });
  return api;
}

const request = {
  model: "gemini-3-flash",
  messages: [
    { role: "system" as const, content: "Answer briefly." },
    { role: "user" as const, content: "Read README.md" },
  ],
  tools: [
    {
      type: "function" as const,
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ],
};

describe("VertexAIApi non-streamed Gemini", () => {
  afterEach(() => {
    server.requests.length = 0;
    server.parts = [];
  });

  it("sends the system prompt as the system instruction, and the tools", async () => {
    server.parts = [{ text: "ok" }];
    await vertex().chatCompletionNonStream(
      request,
      new AbortController().signal,
    );

    const { url, body } = server.requests[0];
    expect(url).toContain(
      "/publishers/google/models/gemini-3-flash:generateContent",
    );
    expect(body.systemInstruction).toEqual({
      parts: [{ text: "Answer briefly." }],
    });
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "Read README.md" }] },
    ]);
    expect(body.tools[0].functionDeclarations[0].name).toBe("read_file");
  });

  it("returns the model's function calls, with their thought signatures", async () => {
    server.parts = [
      { text: "planning", thought: true },
      {
        functionCall: { name: "read_file", args: { path: "README.md" } },
        thoughtSignature: "sig",
      },
    ];
    const completion = await vertex().chatCompletionNonStream(
      request,
      new AbortController().signal,
    );

    const choice = completion.choices[0];
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.content).toBe("");
    expect(choice.message.tool_calls).toEqual([
      {
        id: expect.any(String),
        type: "function",
        function: { name: "read_file", arguments: '{"path":"README.md"}' },
        extra_content: { google: { thought_signature: "sig" } },
      },
    ]);
    expect(completion.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  it("returns the answer's text without thought summaries", async () => {
    server.parts = [
      { text: "thinking", thought: true },
      { text: "Hi " },
      { text: "there" },
    ];
    const completion = await vertex().chatCompletionNonStream(
      request,
      new AbortController().signal,
    );
    expect(completion.choices[0].message.content).toBe("Hi there");
    expect(completion.choices[0].finish_reason).toBe("stop");
  });
});
