import { ModelDescription } from "core";
import { describe, expect, it, vi } from "vitest";

import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { ChatHistoryItemWithMessageId } from "../slices/sessionSlice";
import { cancelCompaction, compactConversation } from "./compactConversation";

const model: ModelDescription = {
  model: "mock",
  provider: "mock",
  title: "Mock LLM",
  underlyingProviderName: "mock",
};

const item = (
  role: "user" | "assistant",
  content: string,
  extra: Partial<ChatHistoryItemWithMessageId> = {},
): ChatHistoryItemWithMessageId => ({
  message: { role, content, id: `${role}-${content}` },
  contextItems: [],
  ...extra,
});

/** A store holding this session, with the mock model selected */
function storeWith(history: ChatHistoryItemWithMessageId[]) {
  const empty = getEmptyRootState();
  const store = createMockStore({
    config: {
      ...empty.config,
      config: {
        ...empty.config.config,
        selectedModelByRole: {
          ...empty.config.config.selectedModelByRole,
          chat: model,
        },
      },
    },
    session: { ...empty.session, id: "session-1", history },
  });
  const toast = vi
    .spyOn(store.mockIdeMessenger.ide, "showToast")
    .mockResolvedValue(undefined);
  const requests: { type: string; data: any }[] = [];
  const request = store.mockIdeMessenger.request.bind(store.mockIdeMessenger);
  vi.spyOn(store.mockIdeMessenger, "request").mockImplementation(
    async (type: any, data: any) => {
      requests.push({ type, data });
      return request(type, data);
    },
  );
  return { store, toast, requests };
}

const history = [
  item("user", "Fix the token check", {
    contextItems: [
      {
        name: "auth.ts",
        description: "src/auth.ts",
        content: "export function checkToken() {}",
        id: { providerTitle: "file", itemId: "1" },
      },
    ],
  }),
  item("assistant", "Fixed it"),
  // Never saved: only the GUI has it
  item("user", "Now add a test"),
];

describe("compactConversation", () => {
  it("summarizes the conversation the GUI shows, as a turn sends it", async () => {
    const { store, requests } = storeWith(history);
    store.mockIdeMessenger.responseHandlers["conversation/compact"] =
      async () => "The token check was fixed.";

    await store.dispatch(compactConversation({ index: 2 }) as any);

    const sent = requests.find((r) => r.type === "conversation/compact")!.data;
    expect(sent).toMatchObject({ sessionId: "session-1", index: 2 });
    const text = JSON.stringify(sent.messages);
    // The system prompt, the attached file and the unsaved message
    expect(sent.messages[0].role).toBe("system");
    expect(text).toContain("export function checkToken() {}");
    expect(text).toContain("Now add a test");
  });

  it("stores the summary on the message and saves, without a reload", async () => {
    const { store, requests } = storeWith(history);
    store.mockIdeMessenger.responseHandlers["conversation/compact"] =
      async () => "The token check was fixed.";

    await store.dispatch(compactConversation({ index: 2 }) as any);

    const state = store.getState() as any;
    expect(state.session.history[2].conversationSummary).toBe(
      "The token check was fixed.",
    );
    expect(state.session.history).toHaveLength(3);
    expect(state.session.compactionLoading[2]).toBeUndefined();
    const types = requests.map((r) => r.type);
    expect(types).toContain("history/save");
    expect(types).not.toContain("history/load");
  });

  it("leaves out an older summary on the same message when compacting again", async () => {
    const { store, requests } = storeWith([
      item("user", "First request"),
      item("assistant", "First answer", {
        conversationSummary: "OLD SUMMARY",
      }),
    ]);
    store.mockIdeMessenger.responseHandlers["conversation/compact"] =
      async () => "New summary";

    await store.dispatch(compactConversation({ index: 1 }) as any);

    const sent = requests.find((r) => r.type === "conversation/compact")!.data;
    const text = JSON.stringify(sent.messages);
    expect(text).not.toContain("OLD SUMMARY");
    expect(text).toContain("First request");
  });

  it("reports a failure and leaves the conversation as it was", async () => {
    const { store, toast } = storeWith(history);
    store.mockIdeMessenger.responseHandlers["conversation/compact"] =
      async () => {
        throw new Error("401 invalid api key");
      };

    await store.dispatch(compactConversation({ index: 2 }) as any);

    expect(toast).toHaveBeenCalledWith(
      "error",
      "Compaction failed: 401 invalid api key",
    );
    const state = store.getState() as any;
    expect(state.session.history[2].conversationSummary).toBeUndefined();
    expect(state.session.compactionLoading[2]).toBeUndefined();
  });

  it("says nothing when the compaction is cancelled", async () => {
    const { store, toast, requests } = storeWith(history);
    let rejectCompaction: (error: Error) => void = () => {};
    store.mockIdeMessenger.responseHandlers["conversation/compact"] = () =>
      new Promise((_, reject) => {
        rejectCompaction = reject;
      });
    store.mockIdeMessenger.responseHandlers["conversation/compact/abort"] =
      async () => {
        rejectCompaction(new Error("This operation was aborted"));
      };

    const compacting = store.dispatch(compactConversation({ index: 2 }) as any);
    await store.dispatch(cancelCompaction({ index: 2 }) as any);
    await compacting;

    expect(
      requests.find((r) => r.type === "conversation/compact/abort")?.data,
    ).toEqual({ sessionId: "session-1", index: 2 });
    expect(toast).not.toHaveBeenCalled();
    expect(
      (store.getState() as any).session.history[2].conversationSummary,
    ).toBeUndefined();
  });

  it("doesn't apply a summary to a session opened in the meantime", async () => {
    const { store } = storeWith(history);
    store.mockIdeMessenger.responseHandlers["conversation/compact"] =
      async () => {
        // The person opens another session while the summary is written
        store.dispatch({
          type: "session/newSession",
          payload: { sessionId: "session-2", title: "", history },
        });
        return "Summary of the old session";
      };

    await store.dispatch(compactConversation({ index: 2 }) as any);

    const state = store.getState() as any;
    expect(state.session.id).toBe("session-2");
    expect(state.session.history[2].conversationSummary).toBeUndefined();
  });
});
