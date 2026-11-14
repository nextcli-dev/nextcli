import { fireEvent, waitFor } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { addAndSelectMockLlm } from "../../../util/test/config";
import { renderWithProviders } from "../../../util/test/render";
import {
  getElementByText,
  getMainEditor,
  sendInputWithMockedResponse,
} from "../../../util/test/utils";
import { Chat } from "../Chat";

/**
 * The arrow keys in the chat input's keymap (editorConfig.ts), through the
 * real editor: ArrowUp recalls a sent message only with the caret at the
 * start, ArrowDown returns to the draft only with the caret at the end.
 * Otherwise the keys move the caret. useInputHistory.test.ts covers the
 * history itself.
 */
function press(editor: Editor, key: "ArrowUp" | "ArrowDown") {
  act(() => {
    fireEvent.keyDown(editor.view.dom, { key });
  });
}

function setCaret(editor: Editor, where: "start" | "end") {
  act(() => {
    editor.commands.setTextSelection(
      where === "start" ? 1 : editor.state.doc.content.size - 1,
    );
  });
}

beforeEach(() => {
  localStorage.clear();
});

test("ArrowUp recalls a sent message only from the start of the input", async () => {
  const { ideMessenger, store } = await renderWithProviders(<Chat />);
  await act(async () => {
    addAndSelectMockLlm(store, ideMessenger);
  });
  await sendInputWithMockedResponse(ideMessenger, "MESSAGE 1", [
    { role: "assistant", content: "REPLY 1" },
  ]);
  await getElementByText("REPLY 1");
  await waitFor(() => expect(store.getState().session.isStreaming).toBe(false));

  const editor = await getMainEditor();
  expect(editor.getText()).toBe("");
  act(() => {
    editor.commands.insertContent("my draft");
  });

  // The caret is after "my draft": the key only moves it
  setCaret(editor, "end");
  press(editor, "ArrowUp");
  expect(editor.getText()).toBe("my draft");

  setCaret(editor, "start");
  press(editor, "ArrowUp");
  expect(editor.getText()).toBe("MESSAGE 1");

  // Back down to the draft, which only the caret at the end allows
  setCaret(editor, "start");
  press(editor, "ArrowDown");
  expect(editor.getText()).toBe("MESSAGE 1");

  setCaret(editor, "end");
  press(editor, "ArrowDown");
  expect(editor.getText()).toBe("my draft");
});
