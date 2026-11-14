import { expect } from "chai";
import { beforeEach, TextEditor } from "vscode-extension-tester";

import "../Baseline";
import { AutocompleteActions } from "../actions/Autocomplete.actions";
import { GlobalActions } from "../actions/Global.actions";

describe("Autocomplete", () => {
  let editor: TextEditor;

  beforeEach(async function () {
    editor = await GlobalActions.openNewUntitledFile();
  });

  it("Should display completions", async () => {
    await AutocompleteActions.testCompletions(editor);
  });
  it("Should force a completion using the command", async () => {
    const ghostText = await AutocompleteActions.forceCompletion(editor);
    expect(ghostText).to.not.be.empty;
  });
});
