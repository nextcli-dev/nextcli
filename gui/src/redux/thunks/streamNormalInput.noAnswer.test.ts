import { JSONContent } from "@tiptap/core";
import { ChatMessage, PromptLog } from "core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { sessionSlice } from "../slices/sessionSlice";
import { RootState } from "../store";
import { getNoAnswerNotice, noAnswerText } from "../util/noAnswerNotice";
import { streamResponseThunk } from "./streamResponse";

vi.mock("../util/getBaseSystemMessage", () => ({
  getBaseSystemMessage: vi.fn(() => "You are a helpful assistant."),
}));

vi.mock(
  "../../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  () => ({
    resolveEditorContent: vi.fn(async () => ({
      selectedContextItems: [],
      selectedCode: [],
      content: "Plan the cleanup",
      legacyCommandWithInput: undefined,
    })),
  }),
);

function getRootStateWithDeepSeek(): RootState {
  const state = getEmptyRootState();
  state.config.config.selectedModelByRole.chat = {
    title: "DeepSeek V4 Pro",
    model: "deepseek-v4-pro",
    provider: "deepseek",
    underlyingProviderName: "deepseek",
  };
  return state;
}

const editorState: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Plan the cleanup" }],
    },
  ],
};

const baseLog: PromptLog = {
  prompt: "Plan the cleanup",
  completion: "",
  modelProvider: "deepseek",
  modelTitle: "DeepSeek V4 Pro",
};

/** Streams the given chunks through the real thunk and returns the store */
async function runTurn(chunks: ChatMessage[], log: PromptLog) {
  const state = getRootStateWithDeepSeek();
  state.session.history = [];
  const store = createMockStore(state);
  store.mockIdeMessenger.responses["llm/compileChat"] = {
    compiledChatMessages: [{ role: "user", content: "Plan the cleanup" }],
    didPrune: false,
    contextPercentage: 0.1,
  };
  store.mockIdeMessenger.llmStreamChat = vi.fn(async function* () {
    for (const chunk of chunks) {
      yield [chunk];
    }
    return log;
  }) as any;
  await store.dispatch(
    streamResponseThunk({
      editorState,
      modifiers: { useCodebase: false, noContext: true },
    }) as any,
  );
  return store;
}

const thinking = (content: string): ChatMessage => ({
  role: "thinking",
  content,
});

describe("a turn that ends without an answer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the output-cap notice when thinking used up maxTokens", async () => {
    const store = await runTurn(
      [thinking("Let me think about "), thinking("what's best.")],
      { ...baseLog, finishReason: "length", outputTokens: 4096 },
    );
    const session = (store.getState() as RootState).session;
    expect(session.isStreaming).toBe(false);
    expect(session.inlineErrorMessage).toEqual({
      kind: "no-answer",
      reason: "length",
      outputTokens: 4096,
    });
  });

  it("says the stream closed early when there was no finish reason", async () => {
    const store = await runTurn([thinking("Let me think")], {
      ...baseLog,
      streamEndedWithoutFinish: true,
    });
    expect((store.getState() as RootState).session.inlineErrorMessage).toEqual({
      kind: "no-answer",
      reason: "incomplete",
    });
  });

  it("shows nothing when the model wrote an answer after thinking", async () => {
    const store = await runTurn(
      [thinking("thinking"), { role: "assistant", content: "The plan" }],
      { ...baseLog, completion: "The plan", finishReason: "stop" },
    );
    expect(
      (store.getState() as RootState).session.inlineErrorMessage,
    ).toBeUndefined();
  });
});

describe("getNoAnswerNotice", () => {
  const user = { message: { role: "user", content: "q" }, contextItems: [] };
  const think = {
    message: { role: "thinking", content: "hmm" },
    contextItems: [],
  };
  const emptyAssistant = {
    message: { role: "assistant", content: "" },
    contextItems: [],
  };

  it("looks only at the output after the last user or tool message", () => {
    const answered = {
      message: { role: "assistant", content: "Earlier answer" },
      contextItems: [],
    };
    expect(
      getNoAnswerNotice(
        [answered, user, emptyAssistant, think] as any,
        baseLog,
      ),
    ).toEqual({ kind: "no-answer", reason: "stop" });
  });

  it("treats a tool call as an answer", () => {
    const toolCall = {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", type: "function", function: { name: "ls" } }],
      },
      contextItems: [],
    };
    expect(
      getNoAnswerNotice([user, think, toolCall] as any, baseLog),
    ).toBeUndefined();
  });

  it("names the output cap with the token count when it is known", () => {
    expect(
      noAnswerText({ kind: "no-answer", reason: "length", outputTokens: 4096 }),
    ).toBe(
      "The model used all its output tokens (4096) before writing an answer. Raise the output limit (maxTokens) for this model.",
    );
  });
});

describe("streamUpdate", () => {
  it("keeps tool calls that arrive in the same chunk as text", () => {
    let state = sessionSlice.reducer(
      getRootStateWithDeepSeek().session,
      sessionSlice.actions.streamUpdate([]),
    );
    state = {
      ...state,
      history: [
        {
          message: { id: "u", role: "user", content: "q" },
          contextItems: [],
        },
        {
          message: { id: "a", role: "assistant", content: "" },
          contextItems: [],
        },
      ],
    };
    state = sessionSlice.reducer(
      state,
      sessionSlice.actions.streamUpdate([
        {
          role: "assistant",
          content: "Reading it.",
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"filepath":"a"}' },
            },
          ],
        },
      ]),
    );
    const last = state.history.at(-1)!;
    expect(last.message.content).toBe("Reading it.");
    expect(last.toolCallStates?.map((s) => s.toolCallId)).toEqual(["call_1"]);
  });
});
