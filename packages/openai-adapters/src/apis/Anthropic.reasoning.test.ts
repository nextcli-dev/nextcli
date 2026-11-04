import { describe, expect, it } from "vitest";

import { AnthropicApi, AnthropicReasoningControls } from "./Anthropic.js";
import {
  anthropicEffortLevels,
  anthropicFastMode,
  clampAnthropicEffort,
} from "./AnthropicUtils.js";

const api = new AnthropicApi({ provider: "anthropic", apiKey: "test-key" });

function convert(
  model: string,
  extra: Record<string, unknown> & AnthropicReasoningControls = {},
) {
  return api._convertToCleanAnthropicBody({
    model,
    messages: [{ role: "user", content: "Hi" }],
    ...extra,
  } as any) as any;
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collect(response: Response) {
  const deltas: any[] = [];
  for await (const chunk of api.handleStreamResponse(response, "claude-x")) {
    if (chunk.choices[0]?.delta) deltas.push(chunk.choices[0].delta);
  }
  return deltas;
}

describe("Claude effort and fast mode rules", () => {
  it("lists the effort levels each model accepts", () => {
    expect(anthropicEffortLevels("claude-sonnet-5-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(anthropicEffortLevels("claude-sonnet-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(anthropicEffortLevels("claude-opus-4-5-20251101")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(anthropicEffortLevels("claude-haiku-4-5")).toEqual([]);
  });

  it("clamps an unsupported effort to the nearest lower level", () => {
    expect(clampAnthropicEffort("claude-sonnet-4-6", "xhigh")).toBe("high");
    expect(clampAnthropicEffort("claude-opus-4-5", "max")).toBe("high");
    expect(clampAnthropicEffort("claude-opus-5-5", "minimal")).toBe("low");
    expect(clampAnthropicEffort("claude-haiku-4-5", "high")).toBeUndefined();
  });

  it("knows which models have fast mode", () => {
    expect(anthropicFastMode("claude-opus-5-5")).toBe("available");
    expect(anthropicFastMode("claude-opus-4-8")).toBe("beta");
    expect(anthropicFastMode("claude-sonnet-5-5")).toBeUndefined();
  });
});

describe("AnthropicApi request controls", () => {
  it("sends effort and summarized thinking for Claude 5 models", () => {
    const body = convert("claude-sonnet-5-5", {
      reasoning_effort: "xhigh",
      nextcli_show_thinking: true,
    });
    expect(body.output_config).toEqual({ effort: "xhigh" });
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("nextcli_show_thinking");
  });

  it("leaves Claude 5 thinking at its default without controls", () => {
    const body = convert("claude-sonnet-5-5");
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it("turns on adaptive thinking for Claude 4.6 when an effort is chosen", () => {
    const body = convert("claude-sonnet-4-6", { reasoning_effort: "medium" });
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "medium" });
  });

  it("uses a thinking budget on models without effort", () => {
    const body = convert("claude-haiku-4-5", {
      reasoning_effort: "high",
      max_tokens: 8192,
    });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 7168 });
    expect(body.output_config).toBeUndefined();
    expect(body.max_tokens).toBe(8192);
  });

  it("sends fast mode only where the model supports it", () => {
    expect(convert("claude-opus-5-5", { nextcli_fast: true }).speed).toBe(
      "fast",
    );
    expect(
      convert("claude-sonnet-5-5", { nextcli_fast: true }).speed,
    ).toBeUndefined();
  });

  it("adds the fast mode beta header for research-preview models", () => {
    const headers = (api as any).getHeaders({
      model: "claude-opus-4-8",
      nextcli_fast: true,
    });
    expect(headers["anthropic-beta"]).toContain("fast-mode-2026-02-01");
  });
});

describe("AnthropicApi sampling parameters", () => {
  it("keeps temperature and top_k on older models without thinking", () => {
    const body = convert("claude-haiku-4-5", { temperature: 0.3, top_k: 40 });
    expect(body.temperature).toBe(0.3);
    expect(body.top_k).toBe(40);
  });

  it("drops temperature and top_k on older models while thinking", () => {
    const body = convert("claude-haiku-4-5", {
      temperature: 0.3,
      top_k: 40,
      top_p: 0.97,
      reasoning_effort: "low",
    });
    expect(body.temperature).toBeUndefined();
    expect(body.top_k).toBeUndefined();
    expect(body.top_p).toBe(0.97);
  });

  it("strips sampling parameters on Claude 4.7 and newer", () => {
    const body = convert("claude-opus-5-5", { temperature: 0.3, top_k: 40 });
    expect(body.temperature).toBeUndefined();
    expect(body.top_k).toBeUndefined();
  });

  it("drops a forced tool_choice under manual thinking", () => {
    const body = convert("claude-haiku-4-5", {
      reasoning_effort: "low",
      tools: [
        {
          type: "function",
          function: { name: "read", parameters: { type: "object" } },
        },
      ],
      tool_choice: { type: "function", function: { name: "read" } },
    });
    expect(body.tool_choice).toEqual({ type: "auto" });
  });
});

describe("AnthropicApi thinking round trip (#12246)", () => {
  it("streams thinking as reasoning and keeps each block's signature", async () => {
    const deltas = await collect(
      sseResponse([
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Plan" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig-0" },
        },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "redacted_thinking", data: "enc" },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "text_delta", text: "Done" },
        },
      ]),
    );
    expect(deltas).toContainEqual({
      reasoning: "Plan",
      reasoning_details: [{ type: "reasoning.text", text: "Plan", index: 0 }],
    });
    expect(deltas).toContainEqual({
      reasoning_details: [
        { type: "reasoning.text", signature: "sig-0", index: 0 },
      ],
    });
    expect(deltas).toContainEqual({
      reasoning_details: [
        { type: "reasoning.encrypted", data: "enc", index: 1 },
      ],
    });
    expect(deltas.some((d) => d.content === "Done")).toBe(true);
  });

  it("sends signed thinking back as the first blocks of the assistant turn", () => {
    const body = api._convertToCleanAnthropicBody({
      model: "claude-sonnet-5-5",
      messages: [
        { role: "user", content: "Read a.ts" },
        {
          role: "assistant",
          content: "Reading",
          tool_calls: [
            {
              id: "toolu_1",
              type: "function",
              function: { name: "read", arguments: '{"path":"a.ts"}' },
            },
          ],
          reasoning: "Plan",
          reasoning_details: [
            { type: "reasoning.text", text: "Plan", signature: "sig-0" },
            { type: "reasoning.text", text: "unsigned" },
            { type: "reasoning.encrypted", data: "enc" },
          ],
        } as any,
        { role: "tool", tool_call_id: "toolu_1", content: "file" },
      ],
    });
    const assistant = body.messages[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toEqual([
      { type: "thinking", thinking: "Plan", signature: "sig-0" },
      { type: "redacted_thinking", data: "enc" },
      { type: "text", text: "Reading" },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "read",
        input: { path: "a.ts" },
      },
    ]);
  });
});

describe("Thinking modes from a model menu", () => {
  it("sends disabled thinking for Off and keeps effort and sampling", () => {
    const body = convert("claude-opus-5-5", {
      nextcli_thinking: "off",
      reasoning_effort: "low",
    });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config).toEqual({ effort: "low" });
  });

  it("allows forced tool use while thinking is off", () => {
    const body = convert("claude-sonnet-4-5", {
      nextcli_thinking: "off",
      tools: [
        {
          type: "function",
          function: { name: "read", parameters: { type: "object" } },
        },
      ],
      tool_choice: { type: "function", function: { name: "read" } },
    });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.tool_choice).toEqual({ type: "tool", name: "read" });
  });

  it("prefers the chosen mode over the older show thinking flag", () => {
    const body = convert("claude-opus-5-5", {
      nextcli_thinking: "hidden",
      nextcli_show_thinking: true,
    });
    expect(body.thinking).toEqual({ type: "adaptive", display: "omitted" });
  });
});
