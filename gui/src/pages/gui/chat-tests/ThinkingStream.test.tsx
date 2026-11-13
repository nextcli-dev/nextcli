import { screen, waitFor } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { ChatMessage } from "core";
import { setMode } from "../../../redux/slices/sessionSlice";
import { streamResponseThunk } from "../../../redux/thunks/streamResponse";
import { addAndSelectMockLlm } from "../../../util/test/config";
import { renderWithProviders } from "../../../util/test/render";
import {
  getElementByTestId,
  sendInputWithMockedResponse,
  verifyNotPresentByTestId,
} from "../../../util/test/utils";
import { Chat } from "../Chat";

const THINKING_CHUNKS: ChatMessage[] = [
  "We need to answer the user. ",
  "The tree provider lists the workspace. ",
  "The folder provider adds file contents.",
].map((content) => ({ role: "thinking", content }));

const ANSWER = "Use the folder provider for a sub-tree.";

/** A DeepSeek-style turn: reasoning first, then the answer */
const REASONING_TURN: ChatMessage[] = [
  ...THINKING_CHUNKS,
  { role: "assistant", content: "Use the folder " },
  { role: "assistant", content: "provider for a sub-tree." },
];

async function renderChatMode() {
  const rendered = await renderWithProviders(<Chat />);
  await act(async () => {
    addAndSelectMockLlm(rendered.store, rendered.ideMessenger);
    rendered.store.dispatch(setMode("chat"));
  });
  return rendered;
}

test("shows the reasoning while a chat-mode turn is still thinking", async () => {
  const { ideMessenger } = await renderChatMode();
  // Slow enough to look at the panel before the answer starts
  ideMessenger.chatStreamDelay = 200;

  await sendInputWithMockedResponse(
    ideMessenger,
    "How do I add a sub-tree?",
    REASONING_TURN,
  );

  const row = await getElementByTestId("thinking-block-peek");
  expect(row).toHaveTextContent("Thinking");
  const content = await getElementByTestId("thinking-block-content");
  await waitFor(() =>
    expect(content).toHaveTextContent("The tree provider lists the workspace."),
  );

  await waitFor(() => expect(screen.getByText(ANSWER)).toBeInTheDocument(), {
    timeout: 3000,
  });
  expect(screen.getByTestId("thinking-block-peek")).toHaveTextContent(
    "Thought",
  );
});

test("shows the second turn's reasoning and answer after a finished turn", async () => {
  const { ideMessenger, store } = await renderChatMode();

  await sendInputWithMockedResponse(ideMessenger, "First question", [
    { role: "assistant", content: "First answer." },
  ]);
  await waitFor(() => expect(store.getState().session.isStreaming).toBe(false));

  ideMessenger.chatStreamDelay = 200;
  ideMessenger.chatResponse = REASONING_TURN;
  // Dispatched directly: after a turn there are two send buttons
  await act(async () => {
    void store.dispatch(
      streamResponseThunk({
        editorState: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Second question" }],
            },
          ],
        },
        modifiers: { useCodebase: false, noContext: true },
      }),
    );
  });

  const content = await getElementByTestId("thinking-block-content");
  await waitFor(() =>
    expect(content).toHaveTextContent("The tree provider lists the workspace."),
  );
  await waitFor(() => expect(screen.getByText(ANSWER)).toBeInTheDocument(), {
    timeout: 3000,
  });
});

test("says it is waiting until the model sends anything", async () => {
  const { ideMessenger } = await renderChatMode();

  // Holds the stream open until the test releases it
  let release!: () => void;
  const firstChunk = new Promise<void>((resolve) => (release = resolve));
  ideMessenger.llmStreamChat = async function* () {
    await firstChunk;
    for (const chunk of REASONING_TURN) {
      yield [chunk];
    }
    return undefined;
  };

  await sendInputWithMockedResponse(
    ideMessenger,
    "How do I add a sub-tree?",
    [],
  );

  const waiting = await getElementByTestId("waiting-for-model");
  expect(waiting).toHaveTextContent("Waiting for the model");

  await act(async () => release());

  await waitFor(() => expect(screen.getByText(ANSWER)).toBeInTheDocument());
  await verifyNotPresentByTestId("waiting-for-model");
});
