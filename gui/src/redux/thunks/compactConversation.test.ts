import { ModelDescription, Session } from "core";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { describe, expect, it, vi } from "vitest";

import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import {
  ChatHistoryItemWithMessageId,
  deleteMessage,
  newSession,
  setActive,
  setContextPercentage,
  setIsPruned,
} from "../slices/sessionSlice";
import { cancelCompaction, compactConversation } from "./compactConversation";
import { deleteSession, loadSession, saveCurrentSession } from "./session";

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
        selectedModelByRole: {
          ...empty.config.config.selectedModelByRole,
          chat: model,
        },
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

/**
 * Session files kept as core keeps them: a missing file loads as an empty
 * session, without an error
 */
function disk(
  handlers: ReturnType<typeof storeWith>["handlers"],
  files: Record<string, Session> = {},
) {
  const copy = (session: Session): Session =>
    JSON.parse(JSON.stringify(session));
  handlers["history/save"] = async (session) => {
    files[session.sessionId] = copy(session);
  };
  handlers["history/load"] = async ({ id }) =>
    files[id]
      ? copy(files[id])
      : {
          sessionId: id,
          title: NEW_SESSION_TITLE,
          workspaceDirectory: "",
          history: [],
        };
  return files;
}

// Lets pending promise callbacks run
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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

  it("writes nothing when the message itself is deleted meanwhile, and says so", async () => {
    const { store, handlers, sent, state, toast } = storeWith(history);
    handlers["conversation/compact"] = async () => {
      store.dispatch(deleteMessage(3));
      return reply("Summary", 3);
    };

    await store.dispatch(compactConversation({ index: 3 }) as any);

    expect(
      state().history.some((i: any) => i.conversationSummary === "Summary"),
    ).toBe(false);
    expect(sent("history/save")).toHaveLength(0);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "warning",
      "The summary wasn't saved: its message is no longer in that chat.",
    );
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

  it("keeps a summary that lands while the chat's first save waits for its title", async () => {
    const { store, handlers, state } = storeWith(history);
    const files = disk(handlers);
    const title = pending<string>();
    handlers["chatDescriber/describe"] = () => title.promise;
    handlers["conversation/compact"] = async () => reply("Summary");

    // The save at the end of a turn, as streamThunkWrapper starts it
    const firstSave = store.dispatch(
      saveCurrentSession({ openNewSession: false, generateTitle: true }) as any,
    );
    const compacting = store.dispatch(compactConversation({ index: 3 }) as any);
    await vi.waitFor(() =>
      expect(state().history[3].conversationSummary).toBe("Summary"),
    );
    title.resolve("Token check");
    await firstSave;
    await compacting;

    expect(files["session-1"].history[3].conversationSummary).toBe("Summary");
    // The later save keeps the title the first one generated
    expect(files["session-1"].title).toBe("Token check");
  });

  it("saves to a chat left before its first save was written", async () => {
    const { store, handlers, toast } = storeWith(history);
    const files = disk(handlers, {
      "session-2": {
        sessionId: "session-2",
        title: "Other",
        workspaceDirectory: "",
        history: [item("user", "Other chat")],
      },
    });
    const title = pending<string>();
    handlers["chatDescriber/describe"] = () => title.promise;
    handlers["conversation/compact"] = async () => {
      // Opening another chat saves this one in the background
      await store.dispatch(
        loadSession({
          sessionId: "session-2",
          saveCurrentSession: true,
        }) as any,
      );
      return reply("Summary of session 1");
    };

    const compacting = store.dispatch(compactConversation({ index: 3 }) as any);
    await vi.waitFor(() =>
      expect((store.getState() as any).session.id).toBe("session-2"),
    );
    await settle();
    title.resolve("Token check");
    await compacting;

    expect(files["session-1"].history[3].conversationSummary).toBe(
      "Summary of session 1",
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it("says so when the chat it belongs to has no saved file", async () => {
    const { store, handlers, sent, toast } = storeWith(history);
    disk(handlers);
    handlers["conversation/compact"] = async () => {
      store.dispatch(
        newSession({
          sessionId: "session-2",
          title: "Other",
          workspaceDirectory: "",
          history: [item("user", "Other chat")],
        }),
      );
      return reply("Summary", 3);
    };

    await store.dispatch(compactConversation({ index: 3 }) as any);

    expect(sent("history/save")).toHaveLength(0);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "warning",
      "The summary wasn't saved: its message is no longer in that chat.",
    );
  });

  it("stores the summary in a chat reopened while its file is read", async () => {
    const { store, handlers, state } = storeWith(history);
    const saved: Session = {
      sessionId: "session-1",
      title: "Token check",
      workspaceDirectory: "",
      history,
    };
    const files = disk(handlers, { "session-1": saved });
    const load = handlers["history/load"]!;
    handlers["history/load"] = async (data) => {
      const session = await load(data);
      // The person goes back to the chat before the summary is written
      store.dispatch(newSession(JSON.parse(JSON.stringify(saved))));
      return session;
    };
    handlers["conversation/compact"] = async () => {
      store.dispatch(
        newSession({
          sessionId: "session-2",
          title: "Other",
          workspaceDirectory: "",
          history: [item("user", "Other chat")],
        }),
      );
      return reply("Summary of session 1");
    };

    await store.dispatch(compactConversation({ index: 3 }) as any);

    expect(state().id).toBe("session-1");
    expect(state().history[3].conversationSummary).toBe("Summary of session 1");
    expect(files["session-1"].history[3].conversationSummary).toBe(
      "Summary of session 1",
    );
  });

  it("reports a summary that couldn't be saved", async () => {
    const { store, handlers, errors, toast } = storeWith(history);
    handlers["conversation/compact"] = async () => reply("Summary", 3);
    errors["history/save"] = "EACCES: permission denied";

    await store.dispatch(compactConversation({ index: 3 }) as any);

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "error",
      "Compaction failed: EACCES: permission denied",
    );
  });

  it("keeps a deleted chat deleted, and leaves other chats' compactions alone", async () => {
    const { store, handlers, sent, toast, state } = storeWith(history);
    const files = disk(handlers, {
      "session-1": {
        sessionId: "session-1",
        title: "Token check",
        workspaceDirectory: "",
        history,
      },
    });
    handlers["history/delete"] = async ({ id }) => {
      delete files[id];
    };
    const first = pending<ReturnType<typeof reply>>();
    const other = pending<ReturnType<typeof reply>>();
    handlers["conversation/compact"] = ({ sessionId }) =>
      sessionId === "session-1" ? first.promise : other.promise;
    // A provider slow to stop: the request settles only later
    handlers["conversation/compact/abort"] = async () => {};
    const otherChat = [
      item("user", "Other chat"),
      item("assistant", "Other answer"),
    ];

    const compacting = store.dispatch(compactConversation({ index: 3 }) as any);
    store.dispatch(
      newSession({
        sessionId: "session-2",
        title: "Other",
        workspaceDirectory: "",
        history: otherChat,
      }),
    );
    const compactingOther = store.dispatch(
      compactConversation({ index: 1 }) as any,
    );
    await store.dispatch(deleteSession("session-1") as any);

    // Only the deleted chat's spinner is cleared
    expect(state().compactionLoading).toEqual({
      [otherChat[1].message.id]: true,
    });
    // A summary that arrives anyway is discarded
    first.resolve(reply("Summary of session 1"));
    other.resolve(reply("Summary of session 2"));
    await compacting;
    await compactingOther;

    expect(sent("history/delete")[0].data).toEqual({ id: "session-1" });
    expect(files["session-1"]).toBeUndefined();
    expect(
      sent("history/save").filter((r) => r.data.sessionId === "session-1"),
    ).toHaveLength(0);
    expect(toast).not.toHaveBeenCalled();
    expect(state().history[1].conversationSummary).toBe("Summary of session 2");
    expect(state().compactionLoading).toEqual({});
  });

  it("writes nothing for a chat deleted while its file is read", async () => {
    const { store, handlers, sent, toast } = storeWith(history);
    const files = disk(handlers, {
      "session-1": {
        sessionId: "session-1",
        title: "Token check",
        workspaceDirectory: "",
        history,
      },
    });
    handlers["history/delete"] = async ({ id }) => {
      delete files[id];
    };
    const load = handlers["history/load"]!;
    handlers["history/load"] = async (data) => {
      const session = await load(data);
      void store.dispatch(deleteSession("session-1") as any);
      return session;
    };
    handlers["conversation/compact"] = async () => {
      store.dispatch(
        newSession({
          sessionId: "session-2",
          title: "Other",
          workspaceDirectory: "",
          history: [item("user", "Other chat")],
        }),
      );
      return reply("Summary of session 1");
    };

    await store.dispatch(compactConversation({ index: 3 }) as any);
    await vi.waitFor(() => expect(files["session-1"]).toBeUndefined());

    expect(sent("history/save")).toHaveLength(0);
    expect(toast).not.toHaveBeenCalled();
  });

  it("deletes a chat only after a write of its file already under way", async () => {
    const { store, handlers } = storeWith(history);
    const files = disk(handlers, {
      "session-1": {
        sessionId: "session-1",
        title: "Token check",
        workspaceDirectory: "",
        history,
      },
    });
    handlers["history/delete"] = async ({ id }) => {
      delete files[id];
    };
    const save = handlers["history/save"]!;
    handlers["history/save"] = async (session) => {
      // The chat is deleted while its file is being written
      void store.dispatch(deleteSession(session.sessionId) as any);
      await settle();
      await save(session);
    };
    handlers["conversation/compact"] = async () => {
      store.dispatch(
        newSession({
          sessionId: "session-2",
          title: "Other",
          workspaceDirectory: "",
          history: [item("user", "Other chat")],
        }),
      );
      return reply("Summary of session 1");
    };

    await store.dispatch(compactConversation({ index: 3 }) as any);
    await vi.waitFor(() => expect(files["session-1"]).toBeUndefined());
  });

  it("hides the context measured before the summary", async () => {
    const { store, handlers, state } = storeWith(history);
    store.dispatch(setIsPruned(true));
    store.dispatch(setContextPercentage(0.95));
    handlers["conversation/compact"] = async () => reply("Summary");

    await store.dispatch(compactConversation({ index: 3 }) as any);

    expect(state().isPruned).toBe(false);
    expect(state().contextPercentage).toBeUndefined();
  });

  it("keeps the context measure after a failure or a cancel", async () => {
    const { store, handlers, errors, state } = storeWith(history);
    store.dispatch(setIsPruned(true));
    store.dispatch(setContextPercentage(0.95));
    errors["conversation/compact"] = "401 invalid api key";
    await store.dispatch(compactConversation({ index: 3 }) as any);

    delete errors["conversation/compact"];
    const answer = pending<ReturnType<typeof reply>>();
    handlers["conversation/compact"] = () => answer.promise;
    handlers["conversation/compact/abort"] = async () =>
      answer.resolve(reply("Partial summ"));
    const compacting = store.dispatch(compactConversation({ index: 3 }) as any);
    await store.dispatch(cancelCompaction({ messageId: targetId }) as any);
    await compacting;

    expect(state().isPruned).toBe(true);
    expect(state().contextPercentage).toBe(0.95);
  });

  it("doesn't compact while a turn runs", async () => {
    const { store, sent, state } = storeWith(history);
    store.dispatch(setActive());

    await store.dispatch(compactConversation({ index: 3 }) as any);

    expect(sent("conversation/compact")).toHaveLength(0);
    expect(state().compactionLoading).toEqual({});
  });
});
