import { Session } from "core";
import { describe, expect, it, vi } from "vitest";

import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import {
  ChatHistoryItemWithMessageId,
  deleteMessage,
  newSession,
  setActive,
} from "../slices/sessionSlice";
import { cancelCompaction, compactConversation } from "./compactConversation";

const item = (
  role: "user" | "assistant",
  content: string,
  extra: Partial<ChatHistoryItemWithMessageId> = {},
): ChatHistoryItemWithMessageId => ({
  message: { role, content, id: `${role}-${content}` },
  contextItems: [],
  ...extra,
});

/**
 * A store holding session-1, with a rule that applies to every turn.
 * Requests answer from `responses` (a value or a function of the data),
 * or with an error reply from `errors`.
 */
function storeWith(history: ChatHistoryItemWithMessageId[]) {
  const empty = getEmptyRootState();
  const store = createMockStore({
    config: {
      ...empty.config,
      config: {
        ...empty.config.config,
        rules: [
          {
            name: "tests-first",
            rule: "RULE: write the tests first.",
            source: "rules-block",
            alwaysApply: true,
          },
        ],
      },
    },
    session: { ...empty.session, id: "session-1", history },
  });
  const toast = vi
    .spyOn(store.mockIdeMessenger.ide, "showToast")
    .mockResolvedValue(undefined);
  const requests: { type: string; data: any }[] = [];
  const errors: Record<string, string | undefined> = {};
  const request = store.mockIdeMessenger.request.bind(store.mockIdeMessenger);
  vi.spyOn(store.mockIdeMessenger, "request").mockImplementation(
    async (type: any, data: any) => {
      requests.push({ type, data });
      if (type in errors) {
        return { status: "error", error: errors[type], done: true } as any;
      }
      return request(type, data);
    },
  );
  const handlers = store.mockIdeMessenger.responseHandlers;
  const sent = (type: string) => requests.filter((r) => r.type === type);
  const state = () => (store.getState() as any).session;
  return { store, toast, handlers, errors, sent, state };
}

/** A reply the test resolves or rejects when it chooses */
function pending<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const reply = (summary: string, shortenedOutputs = 0) => ({
  summary,
  shortenedOutputs,
});

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
  item("assistant", "Fixed it", { conversationSummary: "EARLIER SUMMARY" }),
  // Never saved: only the GUI has it
  item("user", "Now add a test"),
  item("assistant", "Added the test"),
];
const targetId = history[3].message.id;

describe("compactConversation", () => {
  it("sends the conversation without the agent prompt or rules", async () => {
    const { store, handlers, sent } = storeWith(history);
    handlers["conversation/compact"] = async () => reply("Summary");

    await store.dispatch(compactConversation({ index: 3 }) as any);

    const data = sent("conversation/compact")[0].data;
    expect(data).toMatchObject({ sessionId: "session-1", messageId: targetId });
    const text = JSON.stringify(data.messages);
    expect(text).not.toContain("RULE: write the tests first.");
    // The only system message is the earlier summary
    const system = data.messages.filter((m: any) => m.role === "system");
    expect(system).toHaveLength(1);
    expect(system[0].content.replace(/\s+/g, " ")).toBe(
      "Previous conversation summary: EARLIER SUMMARY",
    );
    expect(text).toContain("Now add a test");
  });

  it("keeps the attached context of a conversation without a summary", async () => {
    const { store, handlers, sent } = storeWith([
      history[0],
      item("assistant", "Fixed it"),
    ]);
    handlers["conversation/compact"] = async () => reply("Summary");

    await store.dispatch(compactConversation({ index: 1 }) as any);

    const text = JSON.stringify(sent("conversation/compact")[0].data.messages);
    expect(text).toContain("export function checkToken() {}");
  });

  it("stores the summary on the message and saves, without a reload", async () => {
    const { store, handlers, sent, state } = storeWith(history);
    handlers["conversation/compact"] = async () => reply("New summary");

    await store.dispatch(compactConversation({ index: 3 }) as any);

    expect(state().history[3].conversationSummary).toBe("New summary");
    expect(state().history).toHaveLength(4);
    expect(state().compactionLoading).toEqual({});
    expect(sent("history/save")).toHaveLength(1);
    expect(sent("history/load")).toHaveLength(0);
  });

  it("leaves out an older summary on the same message when compacting again", async () => {
    const { store, handlers, sent } = storeWith(history);
    handlers["conversation/compact"] = async () => reply("Newer summary");

    await store.dispatch(compactConversation({ index: 1 }) as any);

    const text = JSON.stringify(sent("conversation/compact")[0].data.messages);
    expect(text).not.toContain("EARLIER SUMMARY");
    expect(text).toContain("Fix the token check");
  });

  it("stores the summary on the same message after earlier rows are deleted", async () => {
    const { store, handlers, state } = storeWith(history);
    handlers["conversation/compact"] = async () => {
      // The first exchange is deleted while the summary is written
      store.dispatch(deleteMessage(1));
      return reply("Summary");
    };

    await store.dispatch(compactConversation({ index: 3 }) as any);

    expect(state().history.map((i: any) => i.message.id)).toEqual([
      history[2].message.id,
      targetId,
    ]);
    expect(state().history[1].conversationSummary).toBe("Summary");
    expect(state().history[0].conversationSummary).toBeUndefined();
  });

  it("writes nothing when the message itself is deleted meanwhile", async () => {
    const { store, handlers, sent, state } = storeWith(history);
    handlers["conversation/compact"] = async () => {
      store.dispatch(deleteMessage(3));
      return reply("Summary");
    };

    await store.dispatch(compactConversation({ index: 3 }) as any);

    expect(
      state().history.some((i: any) => i.conversationSummary === "Summary"),
    ).toBe(false);
    expect(sent("history/save")).toHaveLength(0);
  });

  it("saves the summary to its own chat when another one was opened", async () => {
    const { store, handlers, sent, state } = storeWith(history);
    const saved: Session = {
      sessionId: "session-1",
      title: "Token check",
      workspaceDirectory: "",
      history,
    };
    handlers["history/load"] = async () => saved;
    let loadingMeanwhile: Record<string, boolean> = {};
    handlers["conversation/compact"] = async () => {
      store.dispatch(
        newSession({
          sessionId: "session-2",
          title: "Other",
          workspaceDirectory: "",
          history: [item("user", "Other chat")],
        }),
      );
      loadingMeanwhile = { ...state().compactionLoading };
      return reply("Summary of session 1");
    };

    await store.dispatch(compactConversation({ index: 3 }) as any);

    // The open chat has no row with that id, so it shows no spinner, and
    // coming back to the first chat would show it
    expect(loadingMeanwhile).toEqual({ [targetId]: true });
    expect(state().id).toBe("session-2");
    expect(state().history[0].conversationSummary).toBeUndefined();
    expect(state().compactionLoading).toEqual({});
    expect(sent("history/load")[0].data).toEqual({ id: "session-1" });
    const written = sent("history/save")[0].data as Session;
    expect(written.sessionId).toBe("session-1");
    expect(written.history[3].conversationSummary).toBe("Summary of session 1");
    expect(written.history[1].conversationSummary).toBe("EARLIER SUMMARY");
  });

  it("cancels the compaction of a chat that is no longer open", async () => {
    const { store, handlers, sent, toast, state } = storeWith(history);
    const answer = pending<ReturnType<typeof reply>>();
    handlers["conversation/compact"] = () => answer.promise;
    handlers["conversation/compact/abort"] = async () =>
      answer.reject(new Error("This operation was aborted"));

    const compacting = store.dispatch(compactConversation({ index: 3 }) as any);
    store.dispatch(
      newSession({
        sessionId: "session-2",
        title: "Other",
        workspaceDirectory: "",
        history: [item("user", "Other chat")],
      }),
    );
    await store.dispatch(cancelCompaction({ messageId: targetId }) as any);
    await compacting;

    expect(sent("conversation/compact/abort")[0].data).toEqual({
      sessionId: "session-1",
      messageId: targetId,
    });
    expect(toast).not.toHaveBeenCalled();
    expect(state().compactionLoading).toEqual({});
  });

  it("runs one compaction per message, and Cancel still stops it", async () => {
    const { store, handlers, sent, toast, state } = storeWith(history);
    const answer = pending<ReturnType<typeof reply>>();
    handlers["conversation/compact"] = () => answer.promise;
    handlers["conversation/compact/abort"] = async () =>
      answer.reject(new Error("This operation was aborted"));

    const first = store.dispatch(compactConversation({ index: 3 }) as any);
    // A second click is ignored, and the spinner stays
    await store.dispatch(compactConversation({ index: 3 }) as any);
    expect(sent("conversation/compact")).toHaveLength(1);
    expect(state().compactionLoading).toEqual({ [targetId]: true });

    await store.dispatch(cancelCompaction({ messageId: targetId }) as any);
    await first;

    expect(sent("conversation/compact/abort")).toHaveLength(1);
    expect(toast).not.toHaveBeenCalled();
    expect(state().compactionLoading).toEqual({});
  });

  it("discards a summary that arrives after Cancel", async () => {
    const { store, handlers, sent, toast, state } = storeWith(history);
    const answer = pending<ReturnType<typeof reply>>();
    handlers["conversation/compact"] = () => answer.promise;
    // The provider ends the stream on abort, so a partial summary comes back
    handlers["conversation/compact/abort"] = async () =>
      answer.resolve(reply("Partial summ"));

    const compacting = store.dispatch(compactConversation({ index: 3 }) as any);
    await store.dispatch(cancelCompaction({ messageId: targetId }) as any);
    await compacting;

    expect(state().history[3].conversationSummary).toBeUndefined();
    expect(sent("history/save")).toHaveLength(0);
    expect(toast).not.toHaveBeenCalled();
  });

  it("reports a failure with its reason and leaves the conversation as it was", async () => {
    const { store, errors, toast, state } = storeWith(history);
    errors["conversation/compact"] = "401 invalid api key";

    await store.dispatch(compactConversation({ index: 3 }) as any);

    expect(toast).toHaveBeenCalledWith(
      "error",
      "Compaction failed: 401 invalid api key",
    );
    expect(state().history[3].conversationSummary).toBeUndefined();
    expect(state().compactionLoading).toEqual({});
  });

  it("adds no toast to an error the extension already showed", async () => {
    const { store, errors, toast, state } = storeWith(history);
    errors["conversation/compact"] = undefined;

    await store.dispatch(compactConversation({ index: 3 }) as any);

    expect(toast).not.toHaveBeenCalled();
    expect(state().compactionLoading).toEqual({});
  });

  it("says how many tool outputs were shortened to fit", async () => {
    const { store, handlers, toast } = storeWith(history);
    handlers["conversation/compact"] = async () => reply("Summary", 3);

    await store.dispatch(compactConversation({ index: 3 }) as any);

    expect(toast).toHaveBeenCalledWith(
      "info",
      "Compacted. 3 tool outputs were shortened to fit the summary request.",
    );
  });

  it("doesn't compact while a turn runs", async () => {
    const { store, sent, state } = storeWith(history);
    store.dispatch(setActive());

    await store.dispatch(compactConversation({ index: 3 }) as any);

    expect(sent("conversation/compact")).toHaveLength(0);
    expect(state().compactionLoading).toEqual({});
  });
});
