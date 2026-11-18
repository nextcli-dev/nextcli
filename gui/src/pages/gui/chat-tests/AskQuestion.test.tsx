import { ALL_SKIPPED_TEXT, DISMISS_TEXT } from "@nextcli/ask-question";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { ChatMessage, ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { askQuestionTool } from "core/tools/definitions/askQuestion";
import { viewDiffTool } from "core/tools/definitions/viewDiff";
import { serializeTool } from "core/tools";
import { vi } from "vitest";
import { generateToolCallButtonTestId } from "../../../components/mainInput/Lump/LumpToolbar/PendingToolCallToolbar";
import { selectActiveTools } from "../../../redux/selectors/selectActiveTools";
import { updateConfig } from "../../../redux/slices/configSlice";
import { newSession, setMode } from "../../../redux/slices/sessionSlice";
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

async function renderWithQuestion(args: unknown, withViewDiff = false) {
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
    // view_diff runs without asking by default; make it wait for approval
    store.dispatch(
      setToolPolicy({
        toolName: viewDiffTool.function.name,
        policy: "allowedWithPermission",
      }),
    );
  });
  ideMessenger.responses["tools/call"] = {
    contextItems: [
      { name: "Diff", description: "git diff", content: "no changes" },
    ],
    errorMessage: undefined,
  };
  const streamChat = vi.spyOn(ideMessenger, "llmStreamChat");
  const request = vi.spyOn(ideMessenger, "request");

  await sendInputWithMockedResponse(
    ideMessenger,
    "Add retries",
    askingResponse(args, withViewDiff),
  );
  const panel = await getElementByTestId("ask-question-panel");
  // The turn after the answers
  ideMessenger.chatResponse = [{ role: "assistant", content: "Going ahead" }];
  return { ...rendered, panel, streamChat, request };
}

function questionState(
  store: Awaited<ReturnType<typeof renderWithQuestion>>["store"],
): ToolCallState | undefined {
  return store
    .getState()
    .session.history.flatMap((item) => item.toolCallStates ?? [])
    .find((state) => state.toolCallId === QUESTION_ID);
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

test("the panel keeps the Lump's keys from rejecting another pending call", async () => {
  const { panel, streamChat, request } = await renderWithQuestion(
    TWO_QUESTIONS,
    true,
  );
  await getElementByTestId(
    generateToolCallButtonTestId("accept", VIEW_DIFF_ID),
  );
  await waitFor(() => expect(panel).toHaveFocus());

  // In the panel, Mod+Backspace dismisses the question, not the other call
  fireEvent.keyDown(panel, { key: "Backspace", metaKey: true, ctrlKey: true });

  await waitFor(() =>
    expect(screen.queryByTestId("ask-question-panel")).not.toBeInTheDocument(),
  );
  expect(
    screen.getByTestId(generateToolCallButtonTestId("accept", VIEW_DIFF_ID)),
  ).toBeInTheDocument();
  expect(lastRequestText(request)).not.toContain(DISMISS_TEXT);
});

test("the model continues only after the question and the other call are done", async () => {
  const { streamChat, request } = await renderWithQuestion(TWO_QUESTIONS, true);
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
