import { ALL_SKIPPED_TEXT, DISMISS_TEXT } from "@nextcli/ask-question";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { ChatMessage, Session, ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { askQuestionTool } from "core/tools/definitions/askQuestion";
import { viewDiffTool } from "core/tools/definitions/viewDiff";
import { serializeTool } from "core/tools";
import { vi } from "vitest";
import { generateToolCallButtonTestId } from "../../../components/mainInput/Lump/LumpToolbar/PendingToolCallToolbar";
import { selectActiveTools } from "../../../redux/selectors/selectActiveTools";
import { updateConfig } from "../../../redux/slices/configSlice";
import {
  newSession,
  setMode,
  updateToolCallOutput,
} from "../../../redux/slices/sessionSlice";
import { resumeDepth } from "../../../redux/thunks/answerQuestion";
import { loadSession, saveCurrentSession } from "../../../redux/thunks/session";
import { setToolPolicy } from "../../../redux/slices/uiSlice";
import { streamResponseThunk } from "../../../redux/thunks/streamResponse";
import { addAndSelectMockLlm } from "../../../util/test/config";
import { renderWithProviders } from "../../../util/test/render";
import {
  getElementByTestId,
  sendInputWithMockedResponse,
} from "../../../util/test/utils";
import { Chat } from "../Chat";

const QUESTION_ID = "question_call";
const VIEW_DIFF_ID = "view_diff_call";

const TWO_QUESTIONS = {
  questions: [
    {
      question: "How should failed requests be retried?",
      header: "Strategy",
      options: [
        { label: "Exponential backoff (Recommended)" },
        { label: "Fixed delay" },
      ],
    },
    {
      question: "Which failures should trigger a retry?",
      options: [
        { label: "HTTP 429" },
        { label: "HTTP 503" },
        { label: "Timeouts" },
      ],
      multiSelect: true,
    },
  ],
};

const ONE_QUESTION = {
  questions: [
    {
      question: "Which database?",
      options: [{ label: "Postgres" }, { label: "SQLite" }],
    },
  ],
};

const FREE_TEXT = {
  questions: [{ question: "Which table should store sessions?", options: [] }],
};

/** A view_diff call next to the question: none, waiting for approval, or running. */
type Sibling = "none" | "approval" | "running";

function askingResponse(args: unknown, withViewDiff = false): ChatMessage[] {
  return [
    { role: "assistant", content: "Two decisions first." },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: QUESTION_ID,
          type: "function",
          function: {
            name: BuiltInToolNames.AskQuestion,
            arguments: JSON.stringify(args),
          },
        },
        ...(withViewDiff
          ? [
              {
                id: VIEW_DIFF_ID,
                type: "function" as const,
                function: { name: viewDiffTool.function.name, arguments: "{}" },
              },
            ]
          : []),
      ],
    },
  ];
}

async function renderWithQuestion(args: unknown, sibling: Sibling = "none") {
  const rendered = await renderWithProviders(<Chat />);
  const { ideMessenger, store } = rendered;
  await act(async () => {
    addAndSelectMockLlm(store, ideMessenger);
    store.dispatch(
      updateConfig({
        ...store.getState().config.config,
        tools: [serializeTool(askQuestionTool), viewDiffTool],
      }),
    );
    if (sibling === "approval") {
      // view_diff runs without asking by default; make it wait for approval
      store.dispatch(
        setToolPolicy({
          toolName: viewDiffTool.function.name,
          policy: "allowedWithPermission",
        }),
      );
    }
  });
  const diffResult = {
    contextItems: [
      { name: "Diff", description: "git diff", content: "no changes" },
    ],
    errorMessage: undefined,
  };
  // A running sibling returns only when the test calls finishSibling
  let finishSibling = () => {};
  if (sibling === "running") {
    ideMessenger.responseHandlers["tools/call"] = () =>
      new Promise((resolve) => {
        finishSibling = () => resolve(diffResult as any);
      });
  } else {
    ideMessenger.responses["tools/call"] = diffResult;
  }
  const streamChat = vi.spyOn(ideMessenger, "llmStreamChat");
  const request = vi.spyOn(ideMessenger, "request");

  await sendInputWithMockedResponse(
    ideMessenger,
    "Add retries",
    askingResponse(args, sibling !== "none"),
  );
  const panel = await getElementByTestId("ask-question-panel");
  // The turn after the answers
  ideMessenger.chatResponse = [{ role: "assistant", content: "Going ahead" }];
  return {
    ...rendered,
    panel,
    streamChat,
    request,
    finishSibling: () => finishSibling(),
  };
}

type Store = Awaited<ReturnType<typeof renderWithQuestion>>["store"];

function toolState(
  store: Store,
  toolCallId: string,
): ToolCallState | undefined {
  return store
    .getState()
    .session.history.flatMap((item) => item.toolCallStates ?? [])
    .find((state) => state.toolCallId === toolCallId);
}

function questionState(store: Store): ToolCallState | undefined {
  return toolState(store, QUESTION_ID);
}

/** Lets a continuation that shouldn't happen get the chance to. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

/**
 * The text of the messages in the last request to the model, taken from the
 * llm/compileChat request (the mock's compiled messages are empty). Without
 * native tools, tool results travel inside message text.
 */
function lastRequestText(request: { mock: { calls: unknown[][] } }) {
  const lastCompile = request.mock.calls
    .filter(([type]) => type === "llm/compileChat")
    .at(-1)?.[1] as { messages: ChatMessage[] } | undefined;
  return (lastCompile?.messages ?? [])
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((part) => (part.type === "text" ? part.text : "")),
    )
    .flat()
    .join("\n");
}

async function click(testId: string) {
  await act(async () => {
    (await getElementByTestId(testId)).click();
  });
}

test("shows the questions in place of the chat input and takes focus", async () => {
  const { panel } = await renderWithQuestion(TWO_QUESTIONS);

  expect(screen.getByTestId("ask-question-text")).toHaveTextContent(
    "How should failed requests be retried?",
  );
  expect(screen.getByTestId("ask-question-count")).toHaveTextContent("1 of 2");
  expect(screen.getByTestId("editor-input-main")).not.toBeVisible();
  await waitFor(() => expect(panel).toHaveFocus());
  expect(screen.getByTestId("tool-call-title")).toHaveTextContent(
    "NextCLI is waiting for your answer · 2 questions",
  );
});

test("answers sent with clicks reach the model and continue the turn", async () => {
  const { store, streamChat, request } =
    await renderWithQuestion(TWO_QUESTIONS);
  const before = streamChat.mock.calls.length;

  // A single-choice pick answers the question and moves on
  await click("ask-question-option-1");
  expect(screen.getByTestId("ask-question-count")).toHaveTextContent("2 of 2");

  await click("ask-question-option-0");
  await click("ask-question-option-2");
  await act(async () => {
    fireEvent.change(await getElementByTestId("ask-question-other"), {
      target: { value: "Connection resets" },
    });
  });
  await click("ask-question-next");

  await screen.findByText("Going ahead");
  expect(streamChat.mock.calls.length).toBe(before + 1);
  expect(lastRequestText(request)).toContain(
    [
      "The user answered your questions:",
      "1. How should failed requests be retried?",
      "   → Fixed delay",
      "2. Which failures should trigger a retry? (multiple choice)",
      "   → HTTP 429; Timeouts",
      '   → Other: "Connection resets"',
    ].join("\n"),
  );
  expect(questionState(store)?.status).toBe("done");
  expect(screen.queryByTestId("ask-question-panel")).not.toBeInTheDocument();
  expect(screen.getByTestId("editor-input-main")).toBeVisible();
});

test("the keyboard picks, pages and sends", async () => {
  const { panel, user, streamChat, request } =
    await renderWithQuestion(TWO_QUESTIONS);
  await waitFor(() => expect(panel).toHaveFocus());

  // Enter picks the highlighted option and moves on
  await user.keyboard("{ArrowDown}{Enter}");
  await waitFor(() =>
    expect(screen.getByTestId("ask-question-count")).toHaveTextContent(
      "2 of 2",
    ),
  );
  await waitFor(() => expect(panel).toHaveFocus());
  // Number keys and Space toggle; Enter sends a multiple-choice question
  await user.keyboard("1{ArrowDown}{ArrowDown} {Enter}");

  await screen.findByText("Going ahead");
  expect(lastRequestText(request)).toContain(
    [
      "The user answered your questions:",
      "1. How should failed requests be retried?",
      "   → Fixed delay",
      "2. Which failures should trigger a retry? (multiple choice)",
      "   → HTTP 429; Timeouts",
    ].join("\n"),
  );
});

test("one single-choice question is sent as soon as an option is clicked", async () => {
  const { streamChat, request } = await renderWithQuestion(ONE_QUESTION);

  await click("ask-question-option-0");

  await screen.findByText("Going ahead");
  expect(lastRequestText(request)).toContain(
    "The user answered your question:\n1. Which database?\n   → Postgres",
  );
});

test("a number key answers a lone question and sends it", async () => {
  const { panel, user, request } = await renderWithQuestion(ONE_QUESTION);
  await waitFor(() => expect(panel).toHaveFocus());

  await user.keyboard("2");

  await screen.findByText("Going ahead");
  expect(lastRequestText(request)).toContain(
    "The user answered your question:\n1. Which database?\n   → SQLite",
  );
});

test("Send jumps back to a question that was neither answered nor skipped", async () => {
  await renderWithQuestion(TWO_QUESTIONS);

  await click("ask-question-following");
  await click("ask-question-option-0");
  await click("ask-question-next");

  expect(screen.getByTestId("ask-question-count")).toHaveTextContent("1 of 2");
  expect(screen.getByRole("status")).toHaveTextContent(
    "Answer or skip question 1 first.",
  );
});

test("skipped questions tell the model to use its judgment", async () => {
  const { panel, user, streamChat, request } =
    await renderWithQuestion(TWO_QUESTIONS);
  await waitFor(() => expect(panel).toHaveFocus());

  await user.keyboard("{Escape}");
  await waitFor(() => expect(panel).toHaveFocus());
  await user.keyboard("{Escape}");

  await screen.findByText("Going ahead");
  expect(lastRequestText(request)).toContain(ALL_SKIPPED_TEXT);
});

test("dismissing ends the turn, gives the input back and saves the session", async () => {
  const { store, streamChat, request } =
    await renderWithQuestion(TWO_QUESTIONS);
  const before = streamChat.mock.calls.length;

  await click("ask-question-dismiss");

  await waitFor(() => expect(questionState(store)?.status).toBe("done"));
  expect(questionState(store)?.output?.[0].content).toBe(DISMISS_TEXT);
  expect(streamChat.mock.calls.length).toBe(before);
  await waitFor(() =>
    expect(request.mock.calls.some(([type]) => type === "history/save")).toBe(
      true,
    ),
  );
  expect(screen.queryByTestId("ask-question-panel")).not.toBeInTheDocument();
  expect(screen.getByTestId("editor-input-main")).toBeVisible();
  expect(screen.getByTestId("tool-call-title")).toHaveTextContent(
    "NextCLI asked you 2 questions · dismissed",
  );
});

test("a new message dismisses the open question first", async () => {
  const { store, streamChat, request } =
    await renderWithQuestion(TWO_QUESTIONS);

  await act(async () => {
    await store.dispatch(
      streamResponseThunk({
        editorState: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Just use defaults" }],
            },
          ],
        },
        modifiers: { useCodebase: false, noContext: true },
      }),
    );
  });

  expect(questionState(store)?.status).toBe("done");
  expect(lastRequestText(request)).toContain(DISMISS_TEXT);
});

test("dismissing with the keyboard ends the turn and cancels a call waiting for approval", async () => {
  const { panel, store, streamChat } = await renderWithQuestion(
    TWO_QUESTIONS,
    "approval",
  );
  await getElementByTestId(
    generateToolCallButtonTestId("accept", VIEW_DIFF_ID),
  );
  await waitFor(() => expect(panel).toHaveFocus());
  const before = streamChat.mock.calls.length;

  // The panel takes Mod+Backspace: the Lump would reject view_diff instead
  // and leave the question open
  fireEvent.keyDown(panel, { key: "Backspace", metaKey: true, ctrlKey: true });

  await waitFor(() =>
    expect(questionState(store)?.output?.[0].content).toBe(DISMISS_TEXT),
  );
  expect(toolState(store, VIEW_DIFF_ID)?.status).toBe("canceled");
  expect(
    screen.queryByTestId(generateToolCallButtonTestId("accept", VIEW_DIFF_ID)),
  ).not.toBeInTheDocument();
  await settle();
  expect(streamChat.mock.calls.length).toBe(before);
});

test("dismissing while another call runs keeps its result and doesn't call the model again", async () => {
  const { store, streamChat, finishSibling } = await renderWithQuestion(
    TWO_QUESTIONS,
    "running",
  );
  await waitFor(() =>
    expect(toolState(store, VIEW_DIFF_ID)?.status).toBe("calling"),
  );
  const before = streamChat.mock.calls.length;

  await click("ask-question-dismiss");
  await act(async () => finishSibling());

  await waitFor(() =>
    expect(toolState(store, VIEW_DIFF_ID)?.status).toBe("done"),
  );
  await settle();
  expect(streamChat.mock.calls.length).toBe(before);
  expect(screen.getByTestId("editor-input-main")).toBeVisible();
});

test("the model continues only after the question and the other call are done", async () => {
  const { streamChat, request } = await renderWithQuestion(
    TWO_QUESTIONS,
    "approval",
  );
  const before = streamChat.mock.calls.length;

  await click("ask-question-option-0");
  await click("ask-question-option-1");
  await click("ask-question-next");
  expect(streamChat.mock.calls.length).toBe(before);

  await click(generateToolCallButtonTestId("accept", VIEW_DIFF_ID));

  await screen.findByText("Going ahead");
  expect(streamChat.mock.calls.length).toBe(before + 1);
  expect(lastRequestText(request)).toContain("→ HTTP 503");
});

test("a session restored with an open question shows the panel again", async () => {
  const { store } = await renderWithQuestion(TWO_QUESTIONS);
  await click("ask-question-option-1");
  const history = store.getState().session.history;

  await act(async () => {
    store.dispatch(newSession());
  });
  expect(screen.queryByTestId("ask-question-panel")).not.toBeInTheDocument();

  await act(async () => {
    store.dispatch(
      newSession({
        sessionId: "restored",
        title: "Retries",
        workspaceDirectory: "",
        history,
      }),
    );
  });
  await getElementByTestId("ask-question-panel");
  // The half-finished answers are still there, on the same page
  expect(screen.getByTestId("ask-question-count")).toHaveTextContent("2 of 2");
  await click("ask-question-previous");
  expect(screen.getByTestId("ask-question-option-1")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("a session loaded from history shows its open question, and answering continues", async () => {
  const { store, ideMessenger } = await renderWithQuestion(TWO_QUESTIONS);
  ideMessenger.responses["history/load"] = {
    sessionId: "saved",
    title: "Retries",
    workspaceDirectory: "",
    history: store.getState().session.history,
  };
  await act(async () => {
    store.dispatch(newSession());
  });
  expect(screen.queryByTestId("ask-question-panel")).not.toBeInTheDocument();

  await act(async () => {
    await store.dispatch(
      loadSession({ sessionId: "saved", saveCurrentSession: false }),
    );
  });
  await getElementByTestId("ask-question-panel");
  await click("ask-question-option-1");
  await click("ask-question-option-0");
  await click("ask-question-next");

  await screen.findByText("Going ahead");
});

test("leaving a session closes a running tool but keeps the question open", async () => {
  const { store, ideMessenger, request, finishSibling } =
    await renderWithQuestion(TWO_QUESTIONS, "running");
  await waitFor(() =>
    expect(toolState(store, VIEW_DIFF_ID)?.status).toBe("calling"),
  );
  const sessionId = store.getState().session.id;

  await act(async () => {
    await store.dispatch(
      saveCurrentSession({ openNewSession: true, generateTitle: false }),
    );
  });
  const saved = request.mock.calls
    .filter(([type]) => type === "history/save")
    .map(([, data]) => data as Session)
    .findLast((session) => session.sessionId === sessionId)!;
  const savedStates = saved.history.flatMap(
    (item) => item.toolCallStates ?? [],
  );
  expect(savedStates.find((tc) => tc.toolCallId === QUESTION_ID)?.status).toBe(
    "calling",
  );
  expect(savedStates.find((tc) => tc.toolCallId === VIEW_DIFF_ID)?.status).toBe(
    "errored",
  );
  // Its late result goes nowhere
  await act(async () => finishSibling());

  ideMessenger.responses["history/load"] = { ...saved, title: "Retries" };
  await act(async () => {
    await store.dispatch(loadSession({ sessionId, saveCurrentSession: false }));
  });
  await getElementByTestId("ask-question-panel");
  await click("ask-question-option-1");
  await click("ask-question-option-0");
  await click("ask-question-next");

  await screen.findByText("Going ahead");
});

test("a free-text question takes typed text, with Shift+Enter for new lines", async () => {
  const { user, request } = await renderWithQuestion(FREE_TEXT);
  const field = await getElementByTestId("ask-question-other");
  await waitFor(() => expect(field).toHaveFocus());

  await user.keyboard("chat{Shift>}{Enter}{/Shift}sessions");
  expect(field).toHaveValue("chat\nsessions");
  await user.keyboard("{Enter}");

  await screen.findByText("Going ahead");
  expect(lastRequestText(request)).toContain(
    "Which table should store sessions?",
  );
  expect(lastRequestText(request)).toContain("sessions");
});

test("an answer resumes at the depth of the round that asked", async () => {
  const { store } = await renderWithQuestion(TWO_QUESTIONS);
  const history = store.getState().session.history;

  // One tool round: model call (0), tool call (1), resume (2)
  expect(resumeDepth(history)).toBe(2);
  // A second round on top adds 3, and the user's message starts over
  expect(resumeDepth([...history, ...history.slice(1)])).toBe(5);
});

test("a long question scrolls inside the panel and follows the highlight", async () => {
  // jsdom has no layout and no scrollIntoView
  const original = Element.prototype.scrollIntoView;
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  try {
    const { panel, user } = await renderWithQuestion({
      questions: [
        {
          question: "Which region?",
          options: Array.from({ length: 12 }, (_, i) => `Region ${i + 1}`),
        },
      ],
    });
    await waitFor(() => expect(panel).toHaveFocus());

    // The options scroll; Send stays outside the scrolling part
    const body = screen.getByTestId("ask-question-body");
    expect(body).toContainElement(screen.getByTestId("ask-question-option-11"));
    expect(body).not.toContainElement(screen.getByTestId("ask-question-next"));

    scrollIntoView.mockClear();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await waitFor(() =>
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(
        screen.getByTestId("ask-question-option-2"),
      ),
    );
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

test("updating an open question without changing its arguments keeps the page", async () => {
  const { store } = await renderWithQuestion(TWO_QUESTIONS);
  await click("ask-question-option-1");
  expect(screen.getByTestId("ask-question-count")).toHaveTextContent("2 of 2");

  await act(async () => {
    store.dispatch(
      updateToolCallOutput({
        toolCallId: QUESTION_ID,
        contextItems: [
          {
            name: "Note",
            description: "",
            content: "still waiting",
            hidden: true,
          },
        ],
      }),
    );
  });

  expect(screen.getByTestId("ask-question-panel")).toBeInTheDocument();
  expect(screen.getByTestId("ask-question-count")).toHaveTextContent("2 of 2");
  // Focus moves back to the panel on the next frame. The editor may still
  // hold it until that frame, which is later when other tests ran first.
  await waitFor(() => {
    expect(screen.getByTestId("ask-question-panel")).toHaveFocus();
  });
});

test("invalid question arguments show the error and leave the chat input up", async () => {
  const { store, ideMessenger } = await renderWithProviders(<Chat />);
  ideMessenger.setChatResponseText("I'll ask that another way.");
  await act(async () => {
    addAndSelectMockLlm(store, ideMessenger);
    store.dispatch(setMode("plan"));
    store.dispatch(
      newSession({
        sessionId: "bad-question",
        title: "Bad question",
        workspaceDirectory: "",
        mode: "plan",
        history: [
          {
            message: {
              role: "user",
              content: "Plan this",
              id: "user-1",
            } as ChatMessage & { id: string },
            contextItems: [],
          },
          {
            message: {
              role: "assistant",
              content: "",
              id: "assistant-1",
            } as ChatMessage & { id: string },
            contextItems: [],
            toolCallStates: [
              {
                toolCallId: "q1",
                status: "calling",
                toolCall: {
                  id: "q1",
                  type: "function",
                  function: {
                    name: BuiltInToolNames.AskQuestion,
                    arguments: "{}",
                  },
                },
                parsedArgs: {},
              },
            ],
          },
        ],
      }),
    );
  });

  // The panel cannot show these arguments, so it must not replace the input.
  // The call is closed with the normalizer's message, and the turn continues.
  expect(screen.queryByTestId("ask-question-panel")).not.toBeInTheDocument();
  const input = screen.getByTestId("continue-input-box-main-editor-input");
  expect(input.querySelector("[hidden]")).toBeNull();

  await waitFor(() => {
    expect(toolState(store, "q1")?.status).toBe("errored");
    expect(toolState(store, "q1")?.output?.[0]?.content).toContain(
      "Pass at least one question",
    );
    const toldTheModel = store.getState().session.history.some((item) => {
      return (
        item.message.role === "tool" &&
        item.message.toolCallId === "q1" &&
        item.message.content.includes("Pass at least one question")
      );
    });
    expect(toldTheModel).toBe(true);
    expect(store.getState().session.isStreaming).toBe(false);
  });
  expect(screen.queryByTestId("ask-question-panel")).not.toBeInTheDocument();
  expect(input.querySelector("[hidden]")).toBeNull();
  expect(screen.getByText("I'll ask that another way.")).toBeInTheDocument();
});

test("plan mode offers the tool and chat mode doesn't", async () => {
  const { store } = await renderWithProviders(<Chat />);
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...store.getState().config.config,
        tools: [serializeTool(askQuestionTool)],
      }),
    );
    store.dispatch(setMode("plan"));
  });
  const names = () =>
    selectActiveTools(store.getState()).map((tool) => tool.function.name);
  expect(names()).toContain(BuiltInToolNames.AskQuestion);

  await act(async () => {
    store.dispatch(setMode("chat"));
  });
  expect(names()).toEqual([]);
});
