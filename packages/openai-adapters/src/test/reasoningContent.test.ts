import { describe, expect, it } from "vitest";
import { ChatCompletionCreateParams } from "openai/resources/index";

import { DeepSeekApi } from "../apis/DeepSeek.js";
import { MoonshotApi } from "../apis/Moonshot.js";

function toolCallHistory(model: string): ChatCompletionCreateParams {
  return {
    model,
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "List the files." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "ls", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "a.txt" },
      {
        role: "assistant",
        content: "Done.",
        reasoning_content: "kept",
      } as any,
      { role: "user", content: "Thanks." },
    ],
  };
}

describe("reasoning_content safety net (#12246)", () => {
  it("DeepSeek adds an empty reasoning_content to assistant messages", () => {
    const api = new DeepSeekApi({ provider: "deepseek", apiKey: "sk-test" });
    const body = api.modifyChatBody(toolCallHistory("deepseek-v4-pro"));
    const [system, user, toolCall, tool, answered, lastUser] =
      body.messages as any[];

    expect(toolCall.reasoning_content).toBe("");
    expect(answered.reasoning_content).toBe("kept");
    for (const message of [system, user, tool, lastUser]) {
      expect(message).not.toHaveProperty("reasoning_content");
    }
  });

  it("Moonshot adds it for Kimi models only", () => {
    const api = new MoonshotApi({ provider: "moonshot", apiKey: "sk-test" });

    const kimi = api.modifyChatBody(toolCallHistory("kimi-k2"));
    expect((kimi.messages[2] as any).reasoning_content).toBe("");

    const legacy = api.modifyChatBody(toolCallHistory("moonshot-v1-8k"));
    expect(legacy.messages[2]).not.toHaveProperty("reasoning_content");
  });
});
