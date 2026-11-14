import { screen, waitFor, within } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { addAndSelectMockLlm } from "../../../util/test/config";
import { renderWithProviders } from "../../../util/test/render";
import {
  getElementByTestId,
  getElementByText,
  sendInputWithMockedResponse,
} from "../../../util/test/utils";
import { Chat } from "../Chat";

test("should render input box", async () => {
  await renderWithProviders(<Chat />);
  await getElementByTestId("continue-input-box-main-editor-input");
});

test("should be able to toggle modes", async () => {
  await renderWithProviders(<Chat />);
  await getElementByText("Agent");

  // Simulate cmd+. keyboard shortcut to toggle modes
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: ".",
        metaKey: true, // cmd key on Mac
      }),
    );
  });

  // Check that it switched to Chat mode
  await getElementByText("Chat");

  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: ".",
        metaKey: true, // cmd key on Mac
      }),
    );
  });

  // Check that it switched to Plan mode
  await getElementByText("Plan");

  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: ".",
        metaKey: true, // cmd key on Mac
      }),
    );
  });

  await getElementByText("Agent");
});

test("should send a message and receive a response", async () => {
  const { ideMessenger, store } = await renderWithProviders(<Chat />);

  // First add and select the mock LLM
  await act(async () => {
    addAndSelectMockLlm(store, ideMessenger);
  });

  const CONTENT = "Expected response";
  const INPUT = "User input";

  await sendInputWithMockedResponse(ideMessenger, INPUT, [
    { role: "assistant", content: CONTENT },
  ]);

  await getElementByText(CONTENT);
});

async function sendAndWaitForAnswer(
  ideMessenger: Parameters<typeof sendInputWithMockedResponse>[0],
  store: { getState: () => { session: { isStreaming: boolean } } },
  question: string,
  answer: string,
) {
  await sendInputWithMockedResponse(ideMessenger, question, [
    { role: "assistant", content: answer },
  ]);
  await getElementByText(answer);
  await waitFor(() => expect(store.getState().session.isStreaming).toBe(false));
}

test("deleting an answer removes that exchange and keeps the others", async () => {
  const { ideMessenger, store } = await renderWithProviders(<Chat />);
  await act(async () => {
    addAndSelectMockLlm(store, ideMessenger);
  });
  for (const i of [0, 1, 2]) {
    await sendAndWaitForAnswer(
      ideMessenger,
      store,
      `Question ${i}`,
      `Answer ${i}`,
    );
  }

  // The first answer is history index 1; after each delete the next
  // exchange moves up to it
  for (const i of [0, 1, 2]) {
    const deleteButton = await getElementByTestId("delete-button-1");
    await act(async () => {
      deleteButton.click();
    });
    await waitFor(() =>
      expect(screen.queryByText(`Answer ${i}`)).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(`Question ${i}`)).not.toBeInTheDocument();
    for (const later of [0, 1, 2].filter((n) => n > i)) {
      expect(screen.getByText(`Answer ${later}`)).toBeInTheDocument();
    }
  }
  expect(store.getState().session.history).toHaveLength(0);
});

test("resubmitting an edited earlier message drops everything after it", async () => {
  const { ideMessenger, store } = await renderWithProviders(<Chat />);
  await act(async () => {
    addAndSelectMockLlm(store, ideMessenger);
  });
  for (const i of [0, 1, 2]) {
    await sendAndWaitForAnswer(
      ideMessenger,
      store,
      `Question ${i}`,
      `Answer ${i}`,
    );
  }

  // The second question is history index 2
  const secondQuestionId = store.getState().session.history[2].message.id;
  const editorElement = await getElementByTestId(
    `editor-input-${secondQuestionId}`,
  );
  const editor = (editorElement as unknown as { editor: Editor }).editor;
  ideMessenger.chatResponse = [{ role: "assistant", content: "Answer 3" }];
  await act(async () => {
    editor.commands.setContent("Question 3");
  });
  const inputBox = await getElementByTestId(
    `continue-input-box-${secondQuestionId}`,
  );
  await act(async () => {
    within(inputBox).getByTestId("submit-input-button").click();
  });

  await getElementByText("Answer 3");
  expect(screen.getByText("Answer 0")).toBeInTheDocument();
  expect(screen.queryByText("Answer 1")).not.toBeInTheDocument();
  expect(screen.queryByText("Answer 2")).not.toBeInTheDocument();
  // User messages store their content as a list of parts
  const text = (content: unknown) =>
    typeof content === "string"
      ? content
      : (content as { text?: string }[]).map((part) => part.text).join("");
  expect(
    store
      .getState()
      .session.history.map((item) => [
        item.message.role,
        text(item.message.content),
      ]),
  ).toEqual([
    ["user", "Question 0"],
    ["assistant", "Answer 0"],
    ["user", "Question 3"],
    ["assistant", "Answer 3"],
  ]);
});
