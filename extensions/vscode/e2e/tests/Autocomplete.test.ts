import { expect } from "chai";
import {
  afterEach,
  before,
  beforeEach,
  EditorView,
  TextEditor,
} from "vscode-extension-tester";

import { AutocompleteActions } from "../actions/Autocomplete.actions";
import { GlobalActions } from "../actions/Global.actions";

describe("Autocomplete", () => {
  let editor: TextEditor;

  before(async function () {
    process.env.NEXT_EDIT_TEST_ENABLED = "false";
    await GlobalActions.disableNextEdit();
  });

  beforeEach(async function () {
    await GlobalActions.openTestWorkspace();
    ({ editor } = await GlobalActions.createAndOpenNewTextFile());
  });

  afterEach(async function () {
    await editor.clearText();
    await new EditorView().closeAllEditors();
  });

  it("Should display completions", async () => {
    await AutocompleteActions.testCompletions(editor);
  });
  it("Should force a completion using the command", async () => {
    const ghostText = await AutocompleteActions.forceCompletion(editor);
    expect(ghostText).to.not.be.empty;
  });
});
