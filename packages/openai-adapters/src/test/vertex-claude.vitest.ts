import { describe, expect, it, vi } from "vitest";

const requests = vi.hoisted(() => [] as Array<{ url: string; body: string }>);

vi.mock("../util.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util.js")>();
  return {
    ...actual,
    customFetch: () => async (url: string, init: { body: string }) => {
      requests.push({ url, body: init.body });
      return new Response(
        JSON.stringify({
          id: "m",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  };
});

import { VertexAIApi } from "../apis/VertexAI.js";

describe("VertexAIApi Claude", () => {
  it("caches the system prompt, tools and newest tool result, like the Anthropic API", async () => {
    const api = new VertexAIApi({
      provider: "vertexai",
      env: { region: "us-east5", projectId: "proj" },
    });
    // Test mock: a Google token without Application Default Credentials
    (api as unknown as { clientPromise: Promise<unknown> }).clientPromise =
      Promise.resolve({ getAccessToken: async () => ({ token: "t" }) });

    await api.chatCompletionNonStream(
      {
        model: "claude-sonnet-5-5",
        messages: [
          { role: "system", content: "You are a coding agent." },
          { role: "user", content: "Read a.ts" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "a",
                type: "function",
                function: { name: "Read", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "a", content: "contents" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "Read", parameters: { type: "object" } },
          },
        ],
      },
      new AbortController().signal,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain("publishers/anthropic/models/");
    const body = JSON.parse(requests[0].body);
    expect(body.anthropic_version).toBe("vertex-2023-10-16");
    expect(body.system).toMatchObject([
      { cache_control: { type: "ephemeral" } },
    ]);
    expect(body.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages.at(-1).content.at(-1)).toMatchObject({
      type: "tool_result",
      cache_control: { type: "ephemeral" },
    });
  });
});
