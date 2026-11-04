import type { ModelDescription } from "core";
import { describe, expect, it, vi } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { streamNormalInput } from "./streamNormalInput";

const OPUS: ModelDescription = {
  title: "Opus 5.5",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
  model: "claude-opus-5-5",
  controls: {
    format: "anthropic",
    efforts: ["low", "high"],
    thinkingModes: ["off", "hidden", "shown"],
    thinkingUnavailable: {},
    defaultThinking: "shown",
    canShowThinking: true,
    thinkingNeedsEffort: false,
    effortNeedsThinking: false,
    fast: true,
    experimental: false,
    contextOptions: [200_000],
    defaultContextLength: 200_000,
  },
};

describe("streamNormalInput model settings", () => {
  it("waits for saved settings when the first message is sent before they load", async () => {
    const state = getEmptyRootState();
    state.config.config.selectedModelByRole.chat = OPUS;
    state.config.config.modelsByRole.chat = [OPUS];
    state.session.history = [
      { message: { id: "1", role: "user", content: "Hi" }, contextItems: [] },
    ];
    const store = createMockStore(state);
    const messenger = store.mockIdeMessenger;
    messenger.responses["modelSettings/getAll"] = {
      "anthropic/claude-opus-5-5": {
        key: "anthropic/claude-opus-5-5",
        thinking: "off",
        effort: "high",
        fast: false,
        contextLength: 200_000,
        stored: { thinking: "off", effort: "high" },
      },
    };
    messenger.responses["llm/compileChat"] = {
      compiledChatMessages: [{ role: "user", content: "Hi" }],
      didPrune: false,
      contextPercentage: 0.1,
    };
    const streamChat = vi.fn().mockReturnValue(
      (async function* () {
        yield [{ role: "assistant", content: "Hello" }];
        return undefined;
      })(),
    );
    messenger.llmStreamChat = streamChat;

    await store.dispatch(streamNormalInput({}) as any);

    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(streamChat.mock.calls[0][0].completionOptions).toMatchObject({
      thinking: "off",
      reasoningEffort: "high",
    });
    expect(!!(store.getState() as any).session.streamThinkingHidden).toBe(
      false,
    );
  });
});
