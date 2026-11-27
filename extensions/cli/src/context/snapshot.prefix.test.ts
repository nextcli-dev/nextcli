import type { ModelConfig } from "@nextcli/config-yaml";
import type { ChatHistoryItem } from "core/index.js";
import { convertFromUnifiedHistoryWithSystemMessage } from "core/util/messageConversion.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ sessionId: "" }));
vi.mock("../session.js", () => ({ getCurrentSession: () => session }));

import { withTraceChain } from "../trace/trace.js";

import { tracedPrefix } from "./snapshot.js";

const model = {
  name: "Test",
  provider: "openai",
  model: "deepseek-v4.1-flash",
} as ModelConfig;
const tools = [
  {
    type: "function" as const,
    function: { name: "Read", parameters: { type: "object" } },
  },
];

const user = (content: string): ChatHistoryItem => ({
  message: { role: "user", content },
  contextItems: [],
});
// A tool round whose reasoning came back as reasoning_content
const toolRound: ChatHistoryItem[] = [
  {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "Read", arguments: '{"filepath":"a.ts"}' },
        },
      ],
    },
    contextItems: [],
    reasoning: {
      active: false,
      text: "Read a.ts first.",
      startAt: 0,
      textField: "reasoning_content",
    },
    toolCallStates: [
      {
        toolCallId: "call_1",
        toolCall: {
          id: "call_1",
          type: "function",
          function: { name: "Read", arguments: '{"filepath":"a.ts"}' },
        },
        status: "done",
        parsedArgs: { filepath: "a.ts" },
        output: [{ name: "a.ts", description: "", content: "x" }],
      },
    ],
  },
];

/** The request a history compiles to, as core builds it */
function send(
  history: ChatHistoryItem[],
  overrides: {
    system?: string;
    settings?: Record<string, unknown>;
    model?: ModelConfig;
    tools?: typeof tools;
  } = {},
) {
  const systemMessage = overrides.system ?? "You are a helper.";
  return tracedPrefix({
    model: overrides.model ?? model,
    settings: overrides.settings ?? { max_tokens: 8000 },
    systemMessage,
    tools: overrides.tools ?? tools,
    messages: convertFromUnifiedHistoryWithSystemMessage(
      history,
      systemMessage,
      { model: model.model },
    ) as ChatCompletionMessageParam[],
  });
}

// An agent loop: what runs inside it is one trace chain
const loop = withTraceChain(
  async (_compacting: boolean, run: () => Promise<void>) => run(),
  (compacting) => compacting,
);

describe("tracedPrefix", () => {
  let sessions = 0;
  beforeEach(() => {
    process.env.NEXTCLI_TRACE = "basic";
    session.sessionId = `session-${++sessions}`;
  });
  afterEach(() => {
    delete process.env.NEXTCLI_TRACE;
  });

  it("is off when tracing is off", async () => {
    delete process.env.NEXTCLI_TRACE;
    expect(await send([user("a")])).toBeUndefined();
  });

  it("keeps a turn's prefix through tool rounds", async () => {
    const first = await send([user("a")]);
    expect(first?.extendsPrevious).toBeUndefined();

    expect(await send([user("a"), ...toolRound])).toEqual({
      systemHash: first?.systemHash,
      toolsHash: first?.toolsHash,
      extendsPrevious: true,
    });
  });

  it("names a dropped reasoning text apart from a rewritten message", async () => {
    await send([user("a"), ...toolRound]);
    // cn sends the reasoning text only until the next user message
    expect(await send([user("a"), ...toolRound, user("b")])).toMatchObject({
      extendsPrevious: false,
      changed: "reasoning",
    });
    expect(
      await send([user("a"), ...toolRound, user("b"), user("c")]),
    ).toMatchObject({ extendsPrevious: true });
  });

  it("names the first part that changed, in cache order", async () => {
    await send([user("a")]);
    expect(
      await send([user("a"), user("b")], { system: "Plan mode." }),
    ).toMatchObject({ extendsPrevious: false, changed: "system" });
    expect(
      await send([user("a"), user("b")], { system: "Plan mode.", tools: [] }),
    ).toMatchObject({ changed: "tools" });
    // Thinking off misses the cached messages; an output cap doesn't
    expect(
      await send([user("a"), user("b")], {
        system: "Plan mode.",
        tools: [],
        settings: { max_tokens: 100 },
      }),
    ).toMatchObject({ extendsPrevious: true });
    expect(
      await send([user("a"), user("b")], {
        system: "Plan mode.",
        tools: [],
        settings: { max_tokens: 100, reasoning_effort: "none" },
      }),
    ).toMatchObject({ changed: "settings" });
    expect(
      await send([user("a"), user("b")], {
        system: "Plan mode.",
        tools: [],
        settings: { max_tokens: 100, reasoning_effort: "none" },
        model: { ...model, model: "deepseek-v4.1-pro" },
      }),
    ).toMatchObject({ changed: "model" });
    expect(
      await send([user("summary")], {
        system: "Plan mode.",
        tools: [],
        settings: { max_tokens: 100, reasoning_effort: "none" },
        model: { ...model, model: "deepseek-v4.1-pro" },
      }),
    ).toMatchObject({ changed: "messages" });
  });

  it("gives each subagent its own chain, and keeps a compaction in its caller's", async () => {
    let parentFirst: Awaited<ReturnType<typeof send>>;
    let parentNext: Awaited<ReturnType<typeof send>>;
    const subagentFirsts: unknown[] = [];
    let summary: Awaited<ReturnType<typeof send>>;

    await loop(false, async () => {
      parentFirst = await send([user("a")]);
      // More subagents than any fixed table would keep
      for (let index = 0; index < 10; index++) {
        await loop(false, async () => {
          const task = await send([user(`task ${index}`)], {
            system: "You are a subagent.",
          });
          subagentFirsts.push(task?.extendsPrevious);
          await send([user(`task ${index}`), user("more")], {
            system: "You are a subagent.",
          });
        });
      }
      parentNext = await send([user("a"), ...toolRound]);
      await loop(true, async () => {
        summary = await send([user("a"), ...toolRound, user("Summarize.")]);
      });
    });

    expect(parentFirst!.extendsPrevious).toBeUndefined();
    expect(subagentFirsts).toEqual(new Array(10).fill(undefined));
    expect(parentNext!).toMatchObject({ extendsPrevious: true });
    // Compared with the parent's last request: only its reasoning text is gone
    expect(summary!).toMatchObject({
      extendsPrevious: false,
      changed: "reasoning",
    });
  });

  it("starts over in a new session", async () => {
    await send([user("a")]);
    session.sessionId = "a-new-chat";
    expect((await send([user("b")]))?.extendsPrevious).toBeUndefined();
  });
});
