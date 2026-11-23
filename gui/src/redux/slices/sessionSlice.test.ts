import { ChatMessage } from "core";
import { renderChatMessage } from "core/util/messageContent";
import { v4 as uuidv4 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addToolCallDeltaToState } from "../../util/toolCallState";
import { ChatHistoryItemWithMessageId, sessionSlice } from "./sessionSlice";

// Mock dependencies
vi.mock("uuid");
vi.mock("core/util/messageContent");
vi.mock("../../util/toolCallState");

// uuid types v4 as overloads; the test only uses the string-returning form.
const mockUuidv4 = vi.mocked(uuidv4 as () => string);
const mockRenderChatMessage = vi.mocked(renderChatMessage);
const mockAddToolCallDeltaToState = vi.mocked(addToolCallDeltaToState);

describe("sessionSlice streamUpdate", () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();

    // Mock uuidv4 to return predictable values
    let callCount = 0;
    mockUuidv4.mockImplementation(() => `mock-uuid-${++callCount}`);

    // Mock renderChatMessage to return content as is
    mockRenderChatMessage.mockImplementation((message: ChatMessage) => {
      if (typeof message.content === "string") {
        return message.content;
      }
      return "";
    });

    // Mock addToolCallDeltaToState
    mockAddToolCallDeltaToState.mockImplementation((delta, state) => {
      return {
        status: "generating" as const,
        toolCall: {
          id: delta.id || "mock-tool-id",
          type: "function" as const,
          function: {
            name: delta.function?.name || "mock-function",
            arguments: delta.function?.arguments || "{}",
          },
        },
        toolCallId: delta.id || "mock-tool-id",
        parsedArgs: {},
      };
    });
  });

  const createInitialState = () => ({
    lastSessionId: undefined,
    allSessionMetadata: [],
    history: [
      {
        message: {
          role: "user" as const,
          content: "This is a test.",
          id: "initial-user-message",
        },
        contextItems: [],
      },
    ] as ChatHistoryItemWithMessageId[],
    isStreaming: false,
    title: "Test Session",
    id: "test-session-id",
    streamAborter: new AbortController(),
    symbols: {},
    mode: "chat" as const,
    isInEdit: false,
    codeBlockApplyStates: {
      states: [],
      curIndex: 0,
    },
    newestToolbarPreviewForInput: {},
    isSessionMetadataLoading: false,
    compactionLoading: {},
    contextBeforeSummary: {},
  });

  describe("Hidden thinking", () => {
    const thinking: ChatMessage = { role: "thinking", content: "Let me check" };

    it("marks reasoning streamed while Thinking is Hidden", () => {
      const reducer = sessionSlice.reducer;
      let state = reducer(
        createInitialState() as any,
        sessionSlice.actions.setStreamThinkingHidden(true),
      );
      state = reducer(state, sessionSlice.actions.streamUpdate([thinking]));
      const item = state.history.find((h) => h.message.role === "thinking");
      expect(item?.thinkingHidden).toBe(true);
    });

    it("keeps an earlier turn's mark when a later stream is Shown", () => {
      const reducer = sessionSlice.reducer;
      let state = reducer(
        createInitialState() as any,
        sessionSlice.actions.setStreamThinkingHidden(false),
      );
      state = reducer(state, sessionSlice.actions.streamUpdate([thinking]));
      const first = state.history.find((h) => h.message.role === "thinking");
      expect(first?.thinkingHidden).toBe(false);
      state = reducer(
        state,
        sessionSlice.actions.setStreamThinkingHidden(true),
      );
      state = reducer(
        state,
        sessionSlice.actions.streamUpdate([
          { role: "assistant", content: "Done." },
        ]),
      );
      expect(
        state.history.find((h) => h.message.role === "thinking")
          ?.thinkingHidden,
      ).toBe(false);
    });
  });

  describe("Basic Chat Message", () => {
    it("should append assistant message to history", () => {
      const initialState = createInitialState();
      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "Here is a response to your message without thinking.",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].message.content).toBe(
        "Here is a response to your message without thinking.",
      );
      expect(newState.history[1].message.id).toBe("mock-uuid-1");
      expect(newState.history[1].contextItems).toEqual([]);
    });
  });

  describe("Chat Message With Thinking", () => {
    it("should split thinking and assistant content correctly", () => {
      const initialState = createInitialState();
      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content:
              "<think>I should send the user a response.</think> Here is a response to your message with thinking.",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);

      // Check reasoning
      expect(newState.history[0].reasoning?.text).toBe(
        "I should send the user a response.",
      );

      // Check assistant message
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].message.content).toBe(
        "Here is a response to your message with thinking.",
      );
      expect(newState.history[1].message.id).toBe("mock-uuid-1");
    });

    it("keeps the chunks that follow a <think> chunk in the same batch", () => {
      const newState = sessionSlice.reducer(
        createInitialState(),
        sessionSlice.actions.streamUpdate([
          { role: "assistant", content: "<think>Plan.</think> First" },
          { role: "assistant", content: " and second." },
        ]),
      );

      expect(newState.history).toHaveLength(2);
      expect(newState.history[0].reasoning?.text).toBe("Plan.");
      expect(newState.history[1].message.content).toBe("First and second.");
    });

    it("does not duplicate the first reasoning_details chunk", () => {
      const initialState = createInitialState();
      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "thinking" as const,
            content: "",
            reasoning_details: [
              { type: "reasoning_id", id: "rs_1" },
              { type: "summary_text", text: "Checking " },
            ],
          },
          {
            role: "thinking" as const,
            content: "",
            reasoning_details: [{ type: "summary_text", text: "the weather." }],
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      const thinking = newState.history[1].message;
      expect(thinking.role).toBe("thinking");
      expect(
        thinking.role === "thinking" && thinking.reasoning_details,
      ).toEqual([
        { type: "reasoning_id", id: "rs_1" },
        { type: "summary_text", text: "Checking the weather." },
      ]);
    });
  });

  describe("Tool Call With Response", () => {
    it("should handle tool call followed by tool response and assistant message", () => {
      const initialState = createInitialState();
      const toolCallAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "<think>I should use a tool call.</think>",
            toolCalls: [
              {
                id: "1234",
                type: "function" as const,
                function: {
                  name: "builtin_ls",
                  arguments: '{"dirPath":".","recursive":false}',
                },
              },
            ],
          },
        ],
      };

      let newState = sessionSlice.reducer(initialState, toolCallAction);
      expect(newState.history).toHaveLength(2);

      // Check reasoning
      expect(newState.history[0].reasoning?.text).toBe(
        "I should use a tool call.",
      );

      // Check generating message
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].message.content).toBe("");
      expect(newState.history[1].toolCallStates?.[0]?.status).toBe(
        "generating",
      );
      expect(newState.history[1].toolCallStates?.[0]?.toolCallId).toBe("1234");

      const toolResponseAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "tool" as const,
            toolCallId: "1234",
            content: "foo.txt\nbar.txt\nexample.php",
          },
          {
            role: "assistant" as const,
            content: "I see, the tool found 3 files.",
          },
        ],
      };
      newState = sessionSlice.reducer(newState, toolResponseAction);
      expect(newState.history).toHaveLength(4);

      // Check tool message
      expect(newState.history[2].message.role).toBe("tool");
      expect(newState.history[2].message.content).toBe(
        "foo.txt\nbar.txt\nexample.php",
      );
      expect((newState.history[2].message as any).toolCallId).toBe("1234");

      // Check final assistant message
      expect(newState.history[3].message.role).toBe("assistant");
      expect(newState.history[3].message.content).toBe(
        "I see, the tool found 3 files.",
      );
    });
  });

  describe("Tool Call With Streaming Response", () => {
    it("should handle streaming assistant response after tool call", () => {
      const initialState = createInitialState();
      const toolCallAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "<think>I should use a tool call.</think>",
            toolCalls: [
              {
                id: "1234",
                type: "function" as const,
                function: {
                  name: "builtin_ls",
                  arguments: '{"dirPath":".","recursive":false}',
                },
              },
            ],
          },
        ],
      };

      let newState = sessionSlice.reducer(initialState, toolCallAction);
      expect(newState.history).toHaveLength(2);

      // Check reasoning
      expect(newState.history[0].reasoning?.text).toBe(
        "I should use a tool call.",
      );

      // Check generating message
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].message.content).toBe("");
      expect(newState.history[1].toolCallStates?.[0]?.status).toBe(
        "generating",
      );
      expect(newState.history[1].toolCallStates?.[0]?.toolCallId).toBe("1234");

      const toolResponseAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "tool" as const,
            toolCallId: "1234",
            content: "foo.txt\nbar.txt\nexample.php",
          },
          {
            role: "assistant" as const,
            content: "<think>",
          },
          {
            role: "assistant" as const,
            content: "Good, ",
          },
          {
            role: "assistant" as const,
            content: "I received a list",
          },
          {
            role: "assistant" as const,
            content: " of files.",
          },
          {
            role: "assistant" as const,
            content: "</think>",
          },
          {
            role: "assistant" as const,
            content: "\n",
          },
          {
            role: "assistant" as const,
            content: "I see, ",
          },
          {
            role: "assistant" as const,
            content: "the tool ",
          },
          {
            role: "assistant" as const,
            content: "found 3 ",
          },
          {
            role: "assistant" as const,
            content: "files.",
          },
        ],
      };

      newState = sessionSlice.reducer(newState, toolResponseAction);

      expect(newState.history).toHaveLength(4);

      // Check tool message
      expect(newState.history[2].message.role).toBe("tool");
      expect(newState.history[2].message.content).toBe(
        "foo.txt\nbar.txt\nexample.php",
      );

      // Check response message
      expect(newState.history[3].message.role).toBe("assistant");
      expect(newState.history[3].message.content).toBe(
        "I see, the tool found 3 files.",
      );
      expect(newState.history[3].reasoning?.text).toBe(
        "Good, I received a list of files.",
      );
      expect(newState.history[3].reasoning?.active).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty history gracefully", () => {
      const initialState = createInitialState();
      initialState.history = [];

      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "Hello",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      // Should not crash and history should remain empty
      expect(newState.history).toHaveLength(0);
    });

    it("should handle redacted thinking messages", () => {
      const initialState = createInitialState();
      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "thinking" as const,
            content: "This should be hidden",
            redactedThinking: true,
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect(newState.history[1].message.role).toBe("thinking");
      expect(newState.history[1].message.content).toBe(
        "internal reasoning is hidden due to safety reasons",
      );
      expect((newState.history[1].message as any).redactedThinking).toBe(true);
    });

    it("should handle signature updates for thinking messages", () => {
      const initialState = createInitialState();
      // First add a thinking message
      initialState.history.push({
        message: {
          role: "thinking",
          content: "Some thinking",
          id: "thinking-message",
        },
        contextItems: [],
      });

      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "thinking" as const,
            signature: "test-signature",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect((newState.history[1].message as any).signature).toBe(
        "test-signature",
      );
    });

    it("should accumulate content for same role messages", () => {
      const initialState = createInitialState();
      // Add an assistant message first
      initialState.history.push({
        message: {
          role: "assistant",
          content: "Hello ",
          id: "assistant-message",
        },
        contextItems: [],
      });

      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "world!",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect(newState.history[1].message.content).toBe("Hello world!");
    });

    it("should handle basic tool call streaming", () => {
      const initialState = createInitialState();
      const toolCallId = "call_123";

      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "",
            toolCalls: [
              {
                id: toolCallId,
                type: "function" as const,
                function: {
                  name: "test_tool",
                  arguments: '{"arg":"value"}',
                },
              },
            ],
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].toolCallStates).toHaveLength(1);
    });
  });
  describe("updateApplyState", () => {
    it("keeps the destructive warning on later updates", () => {
      let state = sessionSlice.reducer(
        createInitialState(),
        sessionSlice.actions.updateApplyState({
          streamId: "s1",
          status: "streaming",
        }),
      );
      state = sessionSlice.reducer(
        state,
        sessionSlice.actions.updateApplyState({
          streamId: "s1",
          status: "done",
          destructiveWarning: "Most of the file was replaced",
        }),
      );
      state = sessionSlice.reducer(
        state,
        sessionSlice.actions.updateApplyState({
          streamId: "s1",
          status: "closed",
        }),
      );

      expect(state.codeBlockApplyStates.states[0]).toMatchObject({
        status: "closed",
        destructiveWarning: "Most of the file was replaced",
      });
    });
  });
});

describe("sessionSlice compaction summaries", () => {
  const { reducer, actions } = sessionSlice;
  const row = (
    role: "user" | "assistant",
    id: string,
    conversationSummary?: string,
  ): ChatHistoryItemWithMessageId => ({
    message: { role, content: id, id },
    contextItems: [],
    ...(conversationSummary && { conversationSummary }),
  });
  type State = ReturnType<typeof reducer>;
  const withHistory = (history: ChatHistoryItemWithMessageId[]): State => ({
    ...sessionSlice.getInitialState(),
    history,
    isPruned: true,
    contextPercentage: 0.9,
  });
  const summaries = (state: State) =>
    state.history.map((item) => [item.message.id, item.conversationSummary]);

  it("deletes the summary of its own message after earlier rows are removed", () => {
    let state = withHistory([
      row("user", "u1"),
      row("assistant", "a1"),
      row("user", "u2"),
      row("assistant", "a2", "Second"),
      row("user", "u3"),
      row("assistant", "a3", "Third"),
    ]);
    // The first exchange is deleted after the summary at index 5 rendered
    state = reducer(state, actions.deleteMessage(1));
    state = reducer(state, actions.deleteCompaction({ messageId: "a3" }));

    expect(summaries(state)).toEqual([
      ["u2", undefined],
      ["a2", "Second"],
      ["u3", undefined],
      ["a3", undefined],
    ]);
  });

  it("changes nothing when deleting the summary of an unknown message", () => {
    const state = withHistory([
      row("user", "u1"),
      row("assistant", "a1", "First"),
    ]);

    expect(
      reducer(state, actions.deleteCompaction({ messageId: "gone" })),
    ).toEqual(state);
  });

  it("drops the context measured before a summary is stored", () => {
    const state = reducer(
      withHistory([row("user", "u1"), row("assistant", "a1")]),
      actions.setConversationSummary({ messageId: "a1", summary: "Summary" }),
    );

    expect(state.history[1].conversationSummary).toBe("Summary");
    expect(state.isPruned).toBe(false);
    expect(state.contextPercentage).toBeUndefined();
  });

  const measure = (state: State) => ({
    isPruned: state.isPruned,
    contextPercentage: state.contextPercentage,
  });
  const exchange = () => [
    row("user", "u1"),
    row("assistant", "a1"),
    row("user", "u2"),
    row("assistant", "a2"),
  ];

  it("puts the measure back when the summary is deleted before any request", () => {
    let state = reducer(
      withHistory(exchange()),
      actions.setConversationSummary({ messageId: "a2", summary: "Summary" }),
    );
    state = reducer(state, actions.deleteCompaction({ messageId: "a2" }));

    expect(measure(state)).toEqual({ isPruned: true, contextPercentage: 0.9 });
  });

  it("keeps the larger measure when a request ran after the summary", () => {
    let state = reducer(
      withHistory(exchange()),
      actions.setConversationSummary({ messageId: "a2", summary: "Summary" }),
    );
    // The next request measured the compacted history
    state = reducer(state, actions.setIsPruned(false));
    state = reducer(state, actions.setContextPercentage(0.3));
    state = reducer(state, actions.deleteCompaction({ messageId: "a2" }));

    expect(measure(state)).toEqual({ isPruned: true, contextPercentage: 0.9 });
  });

  it("keeps a later request's measure when it is the larger one", () => {
    let state = reducer(
      { ...withHistory(exchange()), isPruned: false, contextPercentage: 0.4 },
      actions.setConversationSummary({ messageId: "a2", summary: "Summary" }),
    );
    // Long turns after the summary
    state = reducer(state, actions.setContextPercentage(0.7));
    state = reducer(state, actions.deleteCompaction({ messageId: "a2" }));

    expect(measure(state)).toEqual({ isPruned: false, contextPercentage: 0.7 });
  });

  it("keeps the larger measure whole, with its own pruned flag", () => {
    let state = reducer(
      { ...withHistory(exchange()), isPruned: false, contextPercentage: 0.9 },
      actions.setConversationSummary({ messageId: "a2", summary: "Summary" }),
    );
    // A later turn on the summary came back pruned, at a lower share
    state = reducer(state, actions.setIsPruned(true));
    state = reducer(state, actions.setContextPercentage(0.5));
    state = reducer(state, actions.deleteCompaction({ messageId: "a2" }));

    // The 90% breakdown wasn't pruned; the later request's flag isn't its
    expect(measure(state)).toEqual({ isPruned: false, contextPercentage: 0.9 });
  });

  it("leaves the measure when a later summary is still the one in use", () => {
    let state = reducer(
      withHistory(exchange()),
      actions.setConversationSummary({ messageId: "a1", summary: "Older" }),
    );
    state = reducer(state, actions.setContextPercentage(0.5));
    state = reducer(
      state,
      actions.setConversationSummary({ messageId: "a2", summary: "Newer" }),
    );
    // Requests still send the newer summary
    state = reducer(state, actions.deleteCompaction({ messageId: "a1" }));

    expect(measure(state)).toEqual({
      isPruned: false,
      contextPercentage: undefined,
    });
  });

  it("keeps the measure from before the first summary when compacting again", () => {
    let state = reducer(
      withHistory(exchange()),
      actions.setConversationSummary({ messageId: "a2", summary: "First" }),
    );
    state = reducer(
      state,
      actions.setConversationSummary({ messageId: "a2", summary: "Second" }),
    );
    state = reducer(state, actions.deleteCompaction({ messageId: "a2" }));

    expect(measure(state)).toEqual({ isPruned: true, contextPercentage: 0.9 });
  });

  it("doesn't clear the measure for a summary a later one overrides", () => {
    const state = reducer(
      withHistory([
        row("user", "u1"),
        row("assistant", "a1"),
        row("user", "u2"),
        row("assistant", "a2", "Newer"),
      ]),
      actions.setConversationSummary({ messageId: "a1", summary: "Older" }),
    );

    expect(state.history[1].conversationSummary).toBe("Older");
    expect(measure(state)).toEqual({ isPruned: true, contextPercentage: 0.9 });
  });

  it("keeps the context measure when the summary's message is gone", () => {
    const state = reducer(
      withHistory([row("user", "u1")]),
      actions.setConversationSummary({ messageId: "a1", summary: "Summary" }),
    );

    expect(state.isPruned).toBe(true);
    expect(state.contextPercentage).toBe(0.9);
  });
});

describe("sessionSlice addPromptCompletionPair", () => {
  const { reducer, actions } = sessionSlice;
  const call = (n: number) => ({
    modelTitle: "Model",
    modelProvider: "openai",
    prompt: `the whole conversation, call ${n}`,
    completion: `answer ${n}`,
    usage: { promptTokens: 100 * n, completionTokens: n },
    costUsd: 0.01 * n,
  });
  const state = () => ({
    ...sessionSlice.getInitialState(),
    history: [
      {
        message: { role: "assistant" as const, content: "", id: "a1" },
        contextItems: [],
      },
    ],
  });

  it("stores the call's completion, usage and cost without its prompt", () => {
    const next = reducer(state(), actions.addPromptCompletionPair([call(1)]));

    const { prompt, ...withoutPrompt } = call(1);
    expect(next.history[0].promptLogs).toEqual([withoutPrompt]);
  });

  it("appends each call in order", () => {
    let next = reducer(state(), actions.addPromptCompletionPair([call(1)]));
    next = reducer(next, actions.addPromptCompletionPair([call(2)]));

    expect(next.history[0].promptLogs?.map((log) => log.completion)).toEqual([
      "answer 1",
      "answer 2",
    ]);
  });
});
