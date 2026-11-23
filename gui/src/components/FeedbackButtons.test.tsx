import { within } from "@testing-library/react";
import { ChatHistoryItem } from "core";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../util/test/render";
import { FeedbackButtons } from "./FeedbackButtons";

// Sessions keep each model call's completion and usage, not its prompt
const item: ChatHistoryItem = {
  message: { role: "assistant", content: "Fixed it" },
  contextItems: [],
  promptLogs: [
    {
      modelTitle: "Model",
      modelProvider: "openai",
      completion: "Fixed it",
      usage: { promptTokens: 100, completionTokens: 5 },
    },
  ],
};

describe("FeedbackButtons", () => {
  it("posts chatFeedback for each model call, without a prompt", async () => {
    const { container, user, ideMessenger, store } = await renderWithProviders(
      <FeedbackButtons item={item} />,
    );
    const postSpy = vi.spyOn(ideMessenger, "post");
    const [helpful] = within(container).getAllByRole("button");

    await user.click(helpful);

    const feedback = postSpy.mock.calls.filter(
      ([messageType]) => messageType === "devdata/log",
    );
    expect(feedback).toHaveLength(1);
    const event = feedback[0][1] as { name: string; data: object };
    expect(event.name).toBe("chatFeedback");
    expect(event.data).toMatchObject({
      completion: "Fixed it",
      modelTitle: "Model",
      modelProvider: "openai",
      feedback: true,
      sessionId: store.getState().session.id,
    });
    expect(event.data).not.toHaveProperty("prompt");
  });
});
