import { describe, expect, it } from "vitest";

import { ChatMessage } from "../../index.js";
import MockLLM from "./Mock.js";

function mockWithScript(chatStream: unknown[]) {
  return new MockLLM({
    model: "mock",
    title: "TOOL MOCK LLM",
    requestOptions: { extraBodyProperties: { chatStream } },
  });
}

async function streamTurn(llm: MockLLM, messages: ChatMessage[]) {
  const out: ChatMessage[] = [];
  for await (const message of llm.streamChat(
    messages,
    new AbortController().signal,
  )) {
    out.push(message);
  }
  return out;
}

describe("MockLLM chatStream script", () => {
  it("plays the turn that matches the number of user and tool messages", async () => {
    const llm = mockWithScript([
      [{ role: "assistant", content: "first turn" }],
      ["REPEAT_LAST_MSG"],
    ]);

    expect(await streamTurn(llm, [{ role: "user", content: "hello" }])).toEqual(
      [{ role: "assistant", content: "first turn" }],
    );
    expect(
      await streamTurn(llm, [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "test_id",
              type: "function",
              function: { name: "view_diff", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "tool result", toolCallId: "test_id" },
      ]),
    ).toEqual([{ role: "assistant", content: "tool result" }]);
  });

  it("rejects a turn that is a bare string instead of a list of messages", () => {
    expect(() =>
      mockWithScript([
        [{ role: "assistant", content: "first turn" }],
        "REPEAT_LAST_MSG",
      ]),
    ).toThrow(
      'Mock model "TOOL MOCK LLM": chatStream turn 1 must be a list of messages, got "REPEAT_LAST_MSG"',
    );
  });
});
