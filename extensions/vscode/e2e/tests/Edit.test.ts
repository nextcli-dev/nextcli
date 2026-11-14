import * as fs from "fs";
import * as path from "path";

import { expect } from "chai";
import { beforeEach, TextEditor, WebView } from "vscode-extension-tester";

import "../Baseline";
import { EditActions } from "../actions/Edit.actions";
import { GlobalActions } from "../actions/Global.actions";
import { GUIActions } from "../actions/GUI.actions";
import { EditSelectors } from "../selectors/Edit.selectors";
import { TestUtils } from "../TestUtils";

/**
 * Edit mode end to end: Cmd+I on a selection, a prompt, then the diff
 * resolved from a CodeLens or from the GUI. The diff logic itself is tested
 * in src/diff/vertical/handler.vitest.ts; this checks what needs a real
 * VS Code: the shortcut, the rendered CodeLens and the GUI round trip.
 *
 * Every check reads something an unresolved diff can't fake: while a diff
 * is open, the original line is only a decoration, so the editor's text
 * alone would already look accepted.
 */
describe("Edit", () => {
  const FILE = "edit-fixtures/hello.txt";
  const FILE_PATH = path.resolve(GlobalActions.defaultFolder, FILE);
  const ORIGINAL = "Hello world!\n";
  const { userMessage, llmResponse } = TestUtils.generateTestMessagePair(0);

  let editor: TextEditor;
  let view: WebView;

  beforeEach(async function () {
    fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
    fs.writeFileSync(FILE_PATH, ORIGINAL);
    editor = await GlobalActions.openWorkspaceFile(FILE);
    await GlobalActions.runCommand("editor.action.selectAll");
    await GlobalActions.focusEditor(editor);
    await EditActions.invokeEditShortcut(editor);

    ({ view } = await GUIActions.open());
    await GUIActions.sendMessage({
      view,
      message: userMessage,
      inputFieldIndex: 0,
    });

    // The change is shown: the edit finished and its CodeLenses are there
    await EditActions.waitForEditDone(view);
    await view.switchBack();
    await EditActions.waitForCodeLens(editor, "Accept");
  });

  /** The diff is gone everywhere, and the saved file is exactly `expected` */
  async function expectResolvedTo(expected: string) {
    ({ view } = await GUIActions.open());
    await TestUtils.expectNoElement(() =>
      EditSelectors.getEditAcceptButton(view),
    );
    // Checked with the editor focused. After a CodeLens accept the GUI takes
    // focus, and VS Code keeps showing the resolved block's lenses until the
    // editor has focus again (seen in 1.103.2: still shown after 10s,
    // gone within 1s of focusing the editor).
    await GlobalActions.focusEditor(editor);
    await EditActions.waitForNoCodeLenses(editor);
    await GlobalActions.runCommand("workbench.action.files.save");
    await TestUtils.waitForSuccess(
      async () => {
        expect(fs.readFileSync(FILE_PATH, "utf8")).to.equal(expected);
      },
      undefined,
      250,
      `${FILE} on disk`,
    );
  }

  it("accepts the edit from its CodeLens", async () => {
    await (await EditActions.waitForCodeLens(editor, "Accept")).click();
    await expectResolvedTo(`${llmResponse}\n`);
  });

  it("rejects the edit from the GUI", async () => {
    ({ view } = await GUIActions.open());
    await (await EditSelectors.getEditRejectButton(view)).click();
    await view.switchBack();
    await expectResolvedTo(ORIGINAL);
  });
});
