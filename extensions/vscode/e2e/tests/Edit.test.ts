import { expect } from "chai";
import {
  before,
  beforeEach,
  CodeLens,
  TextEditor,
  WebView,
} from "vscode-extension-tester";

import "../Baseline";
import { EditActions } from "../actions/Edit.actions";
import { GlobalActions } from "../actions/Global.actions";
import { GUIActions } from "../actions/GUI.actions";
import { DEFAULT_TIMEOUT } from "../constants";
import { TestUtils } from "../TestUtils";

describe("Edit Test", () => {
  let view: WebView;
  let editor: TextEditor;
  let originalEditorText = "Hello world!";
  let { userMessage, llmResponse } = TestUtils.generateTestMessagePair();

  beforeEach(async function () {
    editor = await GlobalActions.openNewUntitledFile();
    await GUIActions.toggleGui();

    // The GUI took focus. Give it back to the editor, or typing and the
    // command palette (used by typeTextAt) do not reach it on VS Code 1.101.
    await editor.click();

    await editor.typeTextAt(1, 1, originalEditorText);
    await editor.selectText(originalEditorText);

    await EditActions.invokeEditShortcut(editor);

    ({ view } = await GUIActions.switchToReactIframe());

    await GUIActions.sendMessage({
      view,
      message: userMessage,
      inputFieldIndex: 0,
    });

    await view.switchBack();

    // Wait for the diff to stream into the editor before the test acts on it.
    await TestUtils.waitForSuccess(async () => {
      expect(await editor.getText()).to.include(llmResponse);
    }, DEFAULT_TIMEOUT.MD);
  });

  async function getCodeLensWithRetry(editor: TextEditor, text: string) {
    let codeLens: CodeLens | undefined;
    await TestUtils.waitForSuccess(async () => {
      codeLens = await editor.getCodeLens(text);
      expect(codeLens).to.not.be.undefined;
    }, DEFAULT_TIMEOUT.SM);
    return codeLens;
  }

  it("Accepts an Edit in the GUI", async () => {
    ({ view } = await GUIActions.switchToReactIframe());

    await EditActions.acceptEditInGUI(view);

    await view.switchBack();

    await TestUtils.waitForSuccess(async () => {
      const editorText = await editor.getText();

      expect(editorText).to.not.include(originalEditorText);
      expect(editorText).to.include(llmResponse);
    }, DEFAULT_TIMEOUT.SM);
  });

  it("Rejects an Edit in the GUI", async () => {
    ({ view } = await GUIActions.switchToReactIframe());

    await EditActions.rejectEditInGUI(view);

    await view.switchBack();

    await TestUtils.waitForSuccess(async () => {
      const editorText = await editor.getText();

      expect(editorText).to.include(originalEditorText);
      expect(editorText).to.not.include(llmResponse);
    }, DEFAULT_TIMEOUT.SM);
  });

  it("Accepts an Edit using CodeLens buttons", async () => {
    const acceptCodeLens = await editor.getCodeLens("Accept");
    await acceptCodeLens?.click();

    await TestUtils.waitForSuccess(async () => {
      const editorText = await editor.getText();

      expect(editorText).to.not.include(originalEditorText);
      expect(editorText).to.include(llmResponse);
    }, DEFAULT_TIMEOUT.SM);
  });

  it("Rejects an Edit using CodeLens buttons", async () => {
    const rejectCodeLens = await getCodeLensWithRetry(editor, "Reject");
    await rejectCodeLens?.click();

    await TestUtils.waitForSuccess(async () => {
      const editorText = await editor.getText();

      expect(editorText).to.include(originalEditorText);
      expect(editorText).to.not.include(llmResponse);
    }, DEFAULT_TIMEOUT.SM);
  });
});
